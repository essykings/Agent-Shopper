// The real PayPal client. Every call has a named step and a timeout, so a stuck call fails
// with a message that says which step stopped. Flows match what was verified in sandbox
// (see docs/paypal-findings.md): saved PayPal -> authorize -> capture, and Payouts to the shop.

import { PayPalError } from "./paypal-port.ts";
import type { AuthorizeInput, PayPalPort, PayoutInput, PayoutStatus, RefundInput, RefundStatus } from "./paypal-port.ts";

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** How long any one call may take before it is stopped. */
  timeoutMs?: number;
  /** The id PayPal gave the webhook set up in the developer dashboard. Without it no webhook is believed. */
  webhookId?: string;
  payoutPollIntervalMs?: number;
  payoutPollCount?: number;
}

type Raw = { status: number; body: any; debugId: string | null };

export function toAmount(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("Amounts must be positive whole cents.");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function failure(step: string, r: Raw): PayPalError {
  const b = r.body ?? {};
  const first = Array.isArray(b.details) ? b.details[0] : undefined;
  const text = `HTTP ${r.status} ${b.name ?? b.error ?? ""} ${b.message ?? b.error_description ?? ""}${first?.description ? ` (${first.description})` : ""}`.replace(/\s+/g, " ").trim();
  return new PayPalError(step, r.status, text, first?.issue ?? b.name ?? null, r.debugId);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPayPalClient(cfg: PayPalConfig): PayPalPort {
  const base = cfg.baseUrl ?? "https://api-m.sandbox.paypal.com";
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const pollInterval = cfg.payoutPollIntervalMs ?? 5_000;
  const pollCount = cfg.payoutPollCount ?? 8;
  let cached: { token: string; expiresAt: number } | undefined;

  async function raw(step: string, path: string, init: RequestInit): Promise<Raw> {
    let res: Response;
    try {
      res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: any) {
      const why = err?.name === "TimeoutError" ? `no answer after ${timeoutMs / 1000}s` : String(err?.message ?? err);
      throw new PayPalError(step, 0, why);
    }
    const text = await res.text();
    let body: any = {};
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  }

  async function token(): Promise<string> {
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
    const r = await raw("Get access token", "/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if (r.status < 200 || r.status >= 300) throw failure("Get access token", r);
    cached = { token: r.body.access_token, expiresAt: Date.now() + (Number(r.body.expires_in) || 300) * 1000 };
    return cached.token;
  }

  async function api(step: string, method: "GET" | "POST" | "DELETE", path: string, requestId?: string, body?: unknown): Promise<any> {
    const t = await token();
    const headers: Record<string, string> = { Authorization: `Bearer ${t}`, "Content-Type": "application/json", Prefer: "return=representation" };
    if (requestId) headers["PayPal-Request-Id"] = requestId;
    const r = await raw(step, path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (r.status < 200 || r.status >= 300) throw failure(step, r);
    return r.body;
  }

  return {
    async authorizeSaved(i: AuthorizeInput) {
      const order = await api("Hold the money", "POST", "/v2/checkout/orders", i.requestId, {
        intent: "AUTHORIZE",
        purchase_units: [{ amount: { currency_code: "USD", value: toAmount(i.amountCents) }, description: i.description, custom_id: i.customId }],
        payment_source: { paypal: { vault_id: i.vaultId } },
      });
      let auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (!auth) {
        const a = await api("Hold the money (authorize)", "POST", `/v2/checkout/orders/${order.id}/authorize`, `${i.requestId}-authorize`, {});
        auth = a.purchase_units?.[0]?.payments?.authorizations?.[0];
      }
      if (!auth?.id || auth.status !== "CREATED") {
        throw new PayPalError("Hold the money", 0, `PayPal did not place a hold (status ${auth?.status ?? "none"}).`);
      }
      return { orderId: String(order.id), authorizationId: String(auth.id) };
    },

    async capture(i) {
      const c = await api("Take the money", "POST", `/v2/payments/authorizations/${i.authorizationId}/capture`, i.requestId, { final_capture: true });
      if (c.status !== "COMPLETED") {
        throw new PayPalError("Take the money", 0, `PayPal did not complete the payment (status ${c.status}).`);
      }
      return { captureId: String(c.id) };
    },

    async voidAuthorization(i) {
      await api("Release the hold", "POST", `/v2/payments/authorizations/${i.authorizationId}/void`, i.requestId, undefined);
    },

    async createVaultSetup(i) {
      const s = await api("Start connecting PayPal", "POST", "/v3/vault/setup-tokens", i.requestId, {
        payment_source: {
          paypal: {
            description: "Agent Shopper: pay for purchases within your limits",
            usage_type: "MERCHANT",
            customer_type: "CONSUMER",
            permit_multiple_payment_tokens: false,
            experience_context: { return_url: i.returnUrl, cancel_url: i.cancelUrl },
          },
        },
      });
      const approveUrl = (s.links as Array<{ rel: string; href: string }> | undefined)?.find((l) => l.rel === "approve")?.href;
      if (!s.id || !approveUrl) throw new PayPalError("Start connecting PayPal", 0, "PayPal did not return an approval link.");
      return { setupTokenId: String(s.id), approveUrl };
    },

    async completeVaultSetup(i) {
      const check = await api("Check the PayPal approval", "GET", `/v3/vault/setup-tokens/${i.setupTokenId}`);
      if (check.status !== "APPROVED") throw new PayPalError("Check the PayPal approval", 0, `PayPal says the approval is ${check.status ?? "unknown"}, not approved.`);
      const t = await api("Save the PayPal account", "POST", "/v3/vault/payment-tokens", i.requestId, {
        payment_source: { token: { id: i.setupTokenId, type: "SETUP_TOKEN" } },
      });
      if (!t.id) throw new PayPalError("Save the PayPal account", 0, "PayPal did not return a saved account.");
      return { vaultId: String(t.id), payerEmail: typeof t.payment_source?.paypal?.email_address === "string" ? t.payment_source.paypal.email_address : null };
    },

    async deleteVault(i) {
      await api("Forget the PayPal account", "DELETE", `/v3/vault/payment-tokens/${encodeURIComponent(i.vaultId)}`);
    },

    async refund(i: RefundInput) {
      // Partial or full, always with an amount: the code decides it, never PayPal's default.
      const r = await api("Refund the buyer", "POST", `/v2/payments/captures/${encodeURIComponent(i.captureId)}/refund`, i.requestId, {
        amount: { currency_code: "USD", value: toAmount(i.amountCents) },
        custom_id: i.customId.slice(0, 127),
        note_to_payer: i.note.slice(0, 255),
      });
      const s = String(r.status ?? "").toUpperCase();
      const status: RefundStatus = s === "COMPLETED" ? "completed" : s === "PENDING" ? "pending" : "failed";
      return { refundId: String(r.id), status };
    },

    async verifyWebhook({ headers, rawBody }: { headers: Record<string, string>; rawBody: string }) {
      if (!cfg.webhookId) return false;
      const need = ["paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id", "paypal-transmission-sig", "paypal-transmission-time"];
      if (need.some((h) => !headers[h])) return false;
      // PayPal checks the signature against the exact bytes it sent, so the event is placed into the
      // request as received. Parsing it and writing it out again can change it and fail the check.
      const envelope = JSON.stringify({
        auth_algo: headers["paypal-auth-algo"],
        cert_url: headers["paypal-cert-url"],
        transmission_id: headers["paypal-transmission-id"],
        transmission_sig: headers["paypal-transmission-sig"],
        transmission_time: headers["paypal-transmission-time"],
        webhook_id: cfg.webhookId,
        webhook_event: "@@EVENT@@",
      }).replace('"@@EVENT@@"', () => rawBody);
      try {
        const t = await token();
        const r = await raw("Check the webhook", "/v1/notifications/verify-webhook-signature", {
          method: "POST",
          headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
          body: envelope,
        });
        return r.status === 200 && r.body?.verification_status === "SUCCESS";
      } catch {
        return false;
      }
    },

    async payout(i: PayoutInput) {
      const sent = await api("Pay the shop", "POST", "/v1/payments/payouts", i.batchId, {
        sender_batch_header: { sender_batch_id: i.batchId, email_subject: "Payment from Agent Shopper" },
        items: [{
          recipient_type: "EMAIL",
          receiver: i.receiverEmail,
          amount: { value: toAmount(i.amountCents), currency: "USD" },
          note: i.note,
          sender_item_id: `${i.batchId}-1`,
        }],
      });
      const id = String(sent.batch_header?.payout_batch_id);
      let last = sent;
      for (let n = 0; n < pollCount; n++) {
        await sleep(pollInterval);
        last = await api("Check the payout", "GET", `/v1/payments/payouts/${id}`);
        const s = last.batch_header?.batch_status;
        if (s && s !== "PENDING" && s !== "PROCESSING") break;
      }
      const batch = last.batch_header?.batch_status as string | undefined;
      const item = last.items?.[0]?.transaction_status as string | undefined;
      let status: PayoutStatus = "pending";
      if (batch === "SUCCESS" && item === "SUCCESS") status = "success";
      else if (batch === "DENIED" || batch === "CANCELED" || (item && ["FAILED", "BLOCKED", "RETURNED", "REFUNDED", "REVERSED", "UNCLAIMED"].includes(item))) status = "failed";
      const errors = last.items?.[0]?.errors;
      return { payoutBatchId: id, status, detail: errors ? `${errors.name ?? ""} ${errors.message ?? ""}`.trim() : `batch ${batch ?? "?"}, item ${item ?? "?"}` };
    },
  };
}
