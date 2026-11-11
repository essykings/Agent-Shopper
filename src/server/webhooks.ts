// What PayPal tells us on its own: a refund made somewhere else, a payment that went through while
// we were not looking, a dispute. The caller has already checked the signature (see paypal.ts).
//
// Every handler can run twice without harm, because PayPal repeats events and retries failures:
// money is recorded under an idempotency key, and "set" statements never "add" twice.
//
// UNVERIFIED against real PayPal payloads (the docs do not show them): where the refund's capture
// id and our custom_id sit in PAYMENT.CAPTURE.REFUNDED, and the fields inside CUSTOMER.DISPUTE.*.
// Everything is read defensively, and an event that does not look right is stored and ignored.

import { buildEvidence, orderByCapture } from "./aftercare.ts";
import type { OrderFacts } from "./aftercare.ts";
import type { Pool } from "./db.ts";
import { appendLedger } from "./ledger.ts";

export type WebhookOutcome =
  | "refund_recorded"
  | "refund_already_known"
  | "capture_reconciled"
  | "capture_already_known"
  | "dispute_recorded"
  | "dispute_resolved"
  | "unknown_payment"
  | "not_understood"
  | "ignored";

const obj = (x: unknown): Record<string, any> => (typeof x === "object" && x !== null ? (x as Record<string, any>) : {});
const text = (x: unknown): string => (typeof x === "string" ? x : "");

/** "12.34" -> 1234. Null for anything that is not a plain positive amount. */
export function centsFrom(value: unknown): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(typeof value === "string" || typeof value === "number" ? String(value) : "");
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

/** The capture a refund belongs to: the id at the end of the link that points "up". */
function captureOfRefund(resource: Record<string, any>): string | null {
  const links = Array.isArray(resource["links"]) ? resource["links"] : [];
  const up = links.map(obj).find((l) => l["rel"] === "up");
  const m = /\/captures\/([A-Za-z0-9_-]+)\/?$/.exec(text(up?.["href"]));
  return m?.[1] ?? null;
}

async function recordRefund(pool: Pool, o: OrderFacts, refundId: string, amountCents: number, caseId: string | null): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    // Never past what was paid, whatever PayPal says, in the books and on the order alike.
    const row = (await client.query("select total_cents, refunded_cents from orders where id = $1 for update", [o.orderId])).rows[0];
    const counted = Math.min(amountCents, row.total_cents - row.refunded_cents);
    if (counted <= 0) {
      await client.query("rollback");
      return false;
    }
    const entry = await appendLedger(client, {
      userId: o.userId,
      mandateId: o.mandateId,
      kind: "refund_received",
      amountCents: counted,
      idempotencyKey: `refund:${refundId}`,
      detail: { orderId: o.orderId, refundId, caseId, source: "paypal_webhook", ...(counted < amountCents ? { reportedCents: amountCents } : {}) },
    });
    if (entry.duplicate) {
      await client.query("rollback");
      return false;
    }
    await client.query("update orders set refunded_cents = refunded_cents + $2, updated_at = now() where id = $1", [o.orderId, counted]);
    if (caseId) await client.query("update cases set status = 'refunded', refund_id = $2, updated_at = now() where id = $1 and status = 'open'", [caseId, refundId]);
    await client.query("commit");
    return true;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function onRefund(pool: Pool, resource: Record<string, any>): Promise<WebhookOutcome> {
  const refundId = text(resource["id"]);
  const captureId = captureOfRefund(resource);
  const amount = centsFrom(obj(resource["amount"])["value"]);
  if (!refundId || !captureId || amount === null) return "not_understood";
  const order = await orderByCapture(pool, captureId);
  if (!order) return "unknown_payment";
  // Our own custom_id says which case this refund was for. If it is not ours, it was made elsewhere (for example in PayPal's own dashboard).
  const customId = text(resource["custom_id"]);
  const mine = /^[0-9a-f-]{36}$/i.test(customId) ? (await pool.query("select id from cases where id = $1 and order_id = $2", [customId, order.orderId])).rows[0] : undefined;
  return (await recordRefund(pool, order, refundId, amount, mine?.id ?? null)) ? "refund_recorded" : "refund_already_known";
}

/** A payment PayPal took while we were not looking (a crash between PayPal and our books): bring the books up to date. */
async function onCapture(pool: Pool, resource: Record<string, any>): Promise<WebhookOutcome> {
  const captureId = text(resource["id"]);
  const orderId = text(resource["custom_id"]);
  if (!captureId || !/^[0-9a-f-]{36}$/i.test(orderId)) return "not_understood";
  const o = (await pool.query("select id, user_id, mandate_id, shop_id, total_cents, status from orders where id = $1", [orderId])).rows[0];
  if (!o) return "unknown_payment";
  if (o.status !== "authorizing" && o.status !== "authorized") return "capture_already_known";
  if (centsFrom(obj(resource["amount"])["value"]) !== o.total_cents) return "not_understood";
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("update orders set status = 'captured', paypal_capture_id = $2, updated_at = now() where id = $1 and status in ('authorizing', 'authorized')", [orderId, captureId]);
    await appendLedger(client, { userId: o.user_id, mandateId: o.mandate_id, kind: "payment_captured", amountCents: o.total_cents, idempotencyKey: `capture:${orderId}`, detail: { orderId, captureId, shopId: o.shop_id, source: "paypal_webhook" } });
    await client.query("update mandates set status = 'fulfilled' where id = $1 and status = 'active'", [o.mandate_id]);
    await appendLedger(client, { userId: o.user_id, mandateId: o.mandate_id, kind: "note", detail: { orderId, event: "capture_reconciled", note: "PayPal took the payment but we had not recorded it. The shop has not been paid yet." } });
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return "capture_reconciled";
}

async function onDispute(pool: Pool, type: string, resource: Record<string, any>): Promise<WebhookOutcome> {
  const disputeId = text(resource["dispute_id"]);
  const captureId = text(obj(Array.isArray(resource["disputed_transactions"]) ? resource["disputed_transactions"][0] : null)["seller_transaction_id"]);
  if (!disputeId || !captureId) return "not_understood";
  const order = await orderByCapture(pool, captureId);
  if (!order) return "unknown_payment";
  const amount = centsFrom(obj(resource["dispute_amount"])["value"]) ?? 0;
  const reason = text(resource["reason"]) || "not stated";
  const resolved = type === "CUSTOMER.DISPUTE.RESOLVED";
  const summary = resolved ? `The dispute was resolved (${text(resource["status"]) || "no status given"}).` : `A dispute was opened at PayPal. Reason: ${reason.replace(/_/g, " ").toLowerCase()}.`;
  const evidence = await buildEvidence(pool, order, { kind: "dispute", amountCents: amount, reason: summary });
  await pool.query(
    `insert into cases (user_id, order_id, kind, status, amount_cents, summary, evidence, external_id) values ($1, $2, 'dispute', $3, $4, $5, $6, $7)
     on conflict (external_id) where external_id is not null do update set status = excluded.status, summary = excluded.summary, evidence = excluded.evidence, updated_at = now()`,
    [order.userId, order.orderId, resolved ? "closed" : "open", amount, summary, JSON.stringify(evidence), disputeId],
  );
  if (!resolved) {
    await appendLedger(pool, { userId: order.userId, mandateId: order.mandateId, kind: "dispute_opened", amountCents: amount, idempotencyKey: `dispute:${disputeId}`, detail: { orderId: order.orderId, disputeId, reason } });
  }
  return resolved ? "dispute_resolved" : "dispute_recorded";
}

/** Handles one verified event. Returns what it did. Throws only when something is wrong on our side, so PayPal retries. */
export async function handleWebhook(pool: Pool, event: unknown): Promise<{ id: string; type: string; outcome: WebhookOutcome }> {
  const e = obj(event);
  const id = text(e["id"]);
  const type = text(e["event_type"]);
  const resource = obj(e["resource"]);
  let outcome: WebhookOutcome;
  switch (type) {
    case "PAYMENT.CAPTURE.REFUNDED": outcome = await onRefund(pool, resource); break;
    case "PAYMENT.CAPTURE.COMPLETED": outcome = await onCapture(pool, resource); break;
    case "CUSTOMER.DISPUTE.CREATED":
    case "CUSTOMER.DISPUTE.UPDATED":
    case "CUSTOMER.DISPUTE.RESOLVED": outcome = await onDispute(pool, type, resource); break;
    default: outcome = "ignored";
  }
  // An audit trail of what PayPal sent. Written last, so an event that failed halfway is handled again when PayPal retries.
  if (id) await pool.query("insert into webhook_events (id, event_type, outcome, payload) values ($1, $2, $3, $4) on conflict (id) do update set outcome = excluded.outcome", [id, type, outcome, JSON.stringify(event)]);
  return { id, type, outcome };
}
