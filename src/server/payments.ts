// The payment service. Plain code. It is the only place that calls PayPal for money.
//
// A purchase goes: guard -> hold the money -> guard again with a fresh price -> take the money
// -> pay the shop. The guard is asked twice on purpose: the second time is the last chance to
// stop, and nothing has been taken from the buyer yet.
//
// If the process stops partway, the order row says where it got to. Orders are never deleted.
// (Known gap, to close with PayPal webhooks: a crash after PayPal takes the money but before we
// record it. PayPal's event carries our order id in custom_id, so it can be matched later.)

import { randomUUID } from "node:crypto";
import type { Pool } from "./db.ts";
import { getBalances } from "./balances.ts";
import { appendLedger } from "./ledger.ts";
import { evaluate } from "./guard.ts";
import type { PayPalPort } from "./paypal-port.ts";
import type { Check, GuardContext, GuardResult, Mandate, Proposal, SellerStatus } from "../shared/types.ts";

export interface PurchaseDeps {
  paypal: PayPalPort;
  /** Reads the shop's price again, right now. Null means it could not be read. */
  fetchCurrentTotalCents(proposal: Proposal): Promise<number | null>;
  getSellerStatus(userId: string, shopId: string): Promise<SellerStatus>;
  /**
   * Called once the buyer has been charged and it is on the books, before the shop is paid. It is how
   * the shop learns it has an order to ship. If it fails, the purchase carries on and a note is kept.
   */
  afterCapture?: (info: CapturedOrder) => Promise<void>;
  now?: () => Date;
}

export interface CapturedOrder {
  orderId: string;
  userId: string;
  mandateId: string;
  shopId: string;
  itemKey: string;
  totalCents: number;
}

export interface PurchaseInput {
  userId: string;
  mandateId: string;
  proposal: Proposal;
  /** The owner's OK. It only counts for this proposal, and only up to the amount they saw. */
  approval?: { proposalId: string; approvedTotalCents: number };
}

export type PurchaseResult =
  | { status: "paid_out"; orderId: string; captureId: string; payoutBatchId: string }
  | { status: "payout_pending"; orderId: string; captureId: string; detail: string }
  | { status: "payout_failed"; orderId: string; captureId: string; detail: string }
  | { status: "needs_owner"; checks: Check[] }
  | { status: "denied"; checks: Check[] }
  | { status: "cancelled"; orderId: string; checks: Check[]; reason: string }
  | { status: "failed"; orderId: string; reason: string }
  | { status: "duplicate" };

export class MandateNotActiveError extends Error {
  constructor() {
    super("This request is no longer active.");
    this.name = "MandateNotActiveError";
  }
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const issues = (checks: Check[]) => checks.filter((c) => c.level !== "pass").map((c) => ({ id: c.id, level: c.level, detail: c.detail }));

export async function loadMandate(pool: Pool, userId: string, mandateId: string): Promise<{ mandate: Mandate; setAsideCents: number }> {
  const res = await pool.query(
    `select id, item, condition, max_price_cents, ask_above_cents, to_char(deadline, 'YYYY-MM-DD') as deadline,
            seller_min_score, never_buy, set_aside_cents, status, kind, goal
     from mandates where id = $1 and user_id = $2`,
    [mandateId, userId],
  );
  const r = res.rows[0];
  if (!r) throw new Error("Request not found.");
  if (r.status !== "active") throw new MandateNotActiveError();
  return {
    setAsideCents: r.set_aside_cents,
    mandate: {
      id: r.id,
      item: r.item,
      condition: r.condition,
      maxPriceCents: r.max_price_cents,
      askAboveCents: r.ask_above_cents,
      deadline: r.deadline,
      sellerMinScore: r.seller_min_score,
      neverBuyCategories: r.never_buy,
      ...(r.kind === "gift" ? { kind: "gift" as const, goal: r.goal } : {}),
    },
  };
}

async function buildContext(
  pool: Pool,
  deps: PurchaseDeps,
  userId: string,
  mandate: Mandate,
  setAsideCents: number,
  proposal: Proposal,
  excludeOrderId: string | null,
): Promise<GuardContext> {
  const now = (deps.now ?? (() => new Date()))();
  const [balances, captured, existing, sellerStatus, current] = await Promise.all([
    getBalances(pool, userId, now),
    pool.query<{ n: number }>("select coalesce(sum(amount_cents), 0)::int as n from ledger_entries where mandate_id = $1 and kind = 'payment_captured'", [mandate.id]),
    pool.query<{ e: boolean }>(
      "select exists(select 1 from orders where mandate_id = $1 and status not in ('cancelled', 'failed') and ($2::uuid is null or id <> $2)) as e",
      [mandate.id, excludeOrderId],
    ),
    deps.getSellerStatus(userId, proposal.sellerId),
    deps.fetchCurrentTotalCents(proposal).catch(() => null),
  ]);
  return {
    now,
    sellerStatus,
    monthSpentCents: balances.monthSpentCents,
    monthlyAllowanceCents: balances.monthlyAllowanceCents,
    requestRemainingCents: setAsideCents - captured.rows[0]!.n,
    alreadyOrdered: existing.rows[0]!.e,
    currentTotalCents: current,
  };
}

async function setOrder(pool: Pool, orderId: string, patch: Record<string, string | number | null>): Promise<void> {
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  await pool.query(`update orders set ${sets}, updated_at = now() where id = $1`, [orderId, ...keys.map((k) => patch[k])]);
}

export async function purchase(pool: Pool, deps: PurchaseDeps, input: PurchaseInput): Promise<PurchaseResult> {
  const { userId, mandateId, proposal } = input;
  const { mandate, setAsideCents } = await loadMandate(pool, userId, mandateId);

  const user = await pool.query<{ paypal_vault_id: string | null }>("select paypal_vault_id from users where id = $1", [userId]);
  const vaultId = user.rows[0]?.paypal_vault_id;
  if (!vaultId) throw new Error("PayPal is not connected for this user.");
  const shop = await pool.query<{ payout_email: string }>("select payout_email from shops where id = $1", [proposal.sellerId]);
  if (!shop.rows[0]) throw new Error(`Unknown shop: ${proposal.sellerId}.`);
  const payoutEmail = shop.rows[0].payout_email;

  const approvalOk = input.approval?.proposalId === proposal.id && input.approval.approvedTotalCents >= proposal.totalCents;

  const record = (stage: string, result: GuardResult) =>
    appendLedger(pool, {
      userId,
      mandateId,
      kind: result.decision === "allow" ? "guard_allow" : result.decision === "ask" ? "guard_ask" : "guard_deny",
      detail: { proposalId: proposal.id, stage, totalCents: proposal.totalCents, issues: issues(result.checks) },
      idempotencyKey: `guard:${proposal.id}:${stage}:${result.decision}`,
    });

  // First look.
  const firstCtx = await buildContext(pool, deps, userId, mandate, setAsideCents, proposal, null);
  const first = evaluate(mandate, proposal, firstCtx);
  await record("first", first);
  if (first.decision === "deny") return { status: "denied", checks: first.checks };
  if (first.decision === "ask") {
    if (!approvalOk) return { status: "needs_owner", checks: first.checks };
    await appendLedger(pool, {
      userId,
      mandateId,
      kind: "owner_approved",
      amountCents: input.approval!.approvedTotalCents,
      detail: { proposalId: proposal.id },
      idempotencyKey: `approval:${proposal.id}`,
    });
  }

  // Reserve the order. The unique index lets only one live order exist per request.
  const orderId = randomUUID();
  try {
    await pool.query(
      "insert into orders (id, user_id, mandate_id, shop_id, proposal_id, total_cents, status) values ($1, $2, $3, $4, $5, $6, 'authorizing')",
      [orderId, userId, mandateId, proposal.sellerId, proposal.id, proposal.totalCents],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return { status: "duplicate" };
    throw err;
  }

  // Hold the money on the saved PayPal. Nothing is taken yet.
  let authorizationId: string;
  try {
    const held = await deps.paypal.authorizeSaved({
      vaultId,
      amountCents: proposal.totalCents,
      requestId: `auth-${orderId}`,
      description: `${mandate.item} from ${proposal.sellerId}`,
      customId: orderId,
    });
    authorizationId = held.authorizationId;
    await setOrder(pool, orderId, { status: "authorized", paypal_order_id: held.orderId, paypal_authorization_id: held.authorizationId });
  } catch (err) {
    const reason = describe(err);
    await setOrder(pool, orderId, { status: "failed", failure: reason });
    await appendLedger(pool, { userId, mandateId, kind: "note", detail: { orderId, event: "hold_failed", reason } });
    return { status: "failed", orderId, reason };
  }

  const release = async (why: string): Promise<void> => {
    try {
      await deps.paypal.voidAuthorization({ authorizationId, requestId: `void-${orderId}` });
    } catch (err) {
      await appendLedger(pool, { userId, mandateId, kind: "note", detail: { orderId, event: "release_failed", reason: describe(err), why } });
    }
  };

  // Last look, with a fresh price, before any money is taken.
  const secondCtx = await buildContext(pool, deps, userId, mandate, setAsideCents, proposal, orderId);
  const second = evaluate(mandate, proposal, secondCtx);
  const goAhead = secondCtx.currentTotalCents !== null && (second.decision === "allow" || (second.decision === "ask" && approvalOk));
  if (!goAhead) {
    await record("final", second);
    await release("final check stopped the purchase");
    const reason = issues(second.checks).map((i) => i.detail).join(" ") || "The final check did not pass.";
    await setOrder(pool, orderId, { status: "cancelled", failure: reason });
    return { status: "cancelled", orderId, checks: second.checks, reason };
  }

  // Take the money.
  let captureId: string;
  try {
    captureId = (await deps.paypal.capture({ authorizationId, requestId: `cap-${orderId}` })).captureId;
  } catch (err) {
    const reason = describe(err);
    await release("capture failed");
    await setOrder(pool, orderId, { status: "failed", failure: reason });
    await appendLedger(pool, { userId, mandateId, kind: "note", detail: { orderId, event: "capture_failed", reason } });
    return { status: "failed", orderId, reason };
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("update orders set status = 'captured', paypal_capture_id = $2, updated_at = now() where id = $1", [orderId, captureId]);
    await appendLedger(client, {
      userId,
      mandateId,
      kind: "payment_captured",
      amountCents: proposal.totalCents,
      idempotencyKey: `capture:${orderId}`,
      detail: { orderId, captureId, shopId: proposal.sellerId },
    });
    await client.query("update mandates set status = 'fulfilled' where id = $1 and status = 'active'", [mandateId]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }

  if (deps.afterCapture) {
    try {
      await deps.afterCapture({ orderId, userId, mandateId, shopId: proposal.sellerId, itemKey: proposal.itemKey, totalCents: proposal.totalCents });
    } catch (err) {
      await appendLedger(pool, { userId, mandateId, kind: "note", detail: { orderId, event: "shop_notify_failed", reason: describe(err) } });
    }
  }

  return sendPayout(pool, deps, { orderId, userId, mandateId, totalCents: proposal.totalCents, payoutEmail, captureId });
}

interface PayoutJob {
  orderId: string;
  userId: string;
  mandateId: string;
  totalCents: number;
  payoutEmail: string;
  captureId: string;
}

async function sendPayout(pool: Pool, deps: PurchaseDeps, job: PayoutJob): Promise<PurchaseResult> {
  const attempt = await pool.query<{ n: number }>(
    "update orders set payout_attempts = payout_attempts + 1, updated_at = now() where id = $1 returning payout_attempts as n",
    [job.orderId],
  );
  // PayPal rejects a repeated batch id, so each attempt gets its own.
  const batchId = `payout-${job.orderId}-${attempt.rows[0]!.n}`;

  let outcome: { payoutBatchId: string; status: "success" | "pending" | "failed"; detail?: string };
  try {
    outcome = await deps.paypal.payout({ receiverEmail: job.payoutEmail, amountCents: job.totalCents, batchId, note: `Order ${job.orderId}` });
  } catch (err) {
    outcome = { payoutBatchId: batchId, status: "failed", detail: describe(err) };
  }

  if (outcome.status === "success") {
    await setOrder(pool, job.orderId, { status: "paid_out", payout_batch_id: outcome.payoutBatchId, failure: null });
    await appendLedger(pool, {
      userId: job.userId,
      mandateId: job.mandateId,
      kind: "payout_sent",
      amountCents: job.totalCents,
      idempotencyKey: `payout:${job.orderId}`,
      detail: { orderId: job.orderId, batchId: outcome.payoutBatchId },
    });
    return { status: "paid_out", orderId: job.orderId, captureId: job.captureId, payoutBatchId: outcome.payoutBatchId };
  }

  const detail = outcome.detail ?? "No detail from PayPal.";
  const status = outcome.status === "pending" ? "payout_pending" : "payout_failed";
  await setOrder(pool, job.orderId, { status, payout_batch_id: outcome.payoutBatchId, failure: detail });
  await appendLedger(pool, {
    userId: job.userId,
    mandateId: job.mandateId,
    kind: "note",
    detail: { orderId: job.orderId, event: status, batchId: outcome.payoutBatchId, detail },
  });
  return { status, orderId: job.orderId, captureId: job.captureId, detail };
}

/** Tries again to pay a shop after a failed payout. The buyer is never charged a second time. */
export async function retryPayout(pool: Pool, deps: PurchaseDeps, orderId: string): Promise<PurchaseResult> {
  const res = await pool.query(
    `select o.user_id, o.mandate_id, o.total_cents, o.status, o.paypal_capture_id, s.payout_email
     from orders o join shops s on s.id = o.shop_id where o.id = $1`,
    [orderId],
  );
  const o = res.rows[0];
  if (!o) throw new Error("Order not found.");
  if (o.status !== "payout_failed") throw new Error("Only an order with a failed payout can be retried.");
  return sendPayout(pool, deps, {
    orderId,
    userId: o.user_id,
    mandateId: o.mandate_id,
    totalCents: o.total_cents,
    payoutEmail: o.payout_email,
    captureId: o.paypal_capture_id,
  });
}
