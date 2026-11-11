// Sandbox test: can our app charge a buyer's saved PayPal and send the money to a DIFFERENT shop?
//
// Test A (control): saved PayPal -> our own account.  Proves the saving + charging part works.
// Test B (the real question): saved PayPal -> payee = a demo shop's sandbox business account.
//
// Run:  node --env-file=.env scripts/payee-test.ts
// Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, SHOP_PAYEE_EMAIL
// Optional:      VAULT_ID (reuse a saved PayPal from an earlier run and skip the approval step)

import { createInterface } from "node:readline/promises";

const API = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 20_000;
const AMOUNT = "5.00";

const REQUIRED = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "SHOP_PAYEE_EMAIL"] as const;

function checkEnv(): Record<(typeof REQUIRED)[number], string> {
  console.log("Settings (names and lengths only):");
  const missing: string[] = [];
  for (const name of REQUIRED) {
    const value = process.env[name] ?? "";
    console.log(`  ${name}: ${value ? `${value.length} chars` : "MISSING"}`);
    if (!value) missing.push(name);
  }
  console.log(`  VAULT_ID: ${process.env.VAULT_ID ? "set (approval step skipped)" : "not set"}`);
  if (missing.length) {
    console.error(`\nAdd ${missing.join(", ")} to .env (see .env.example), then run again.`);
    process.exit(1);
  }
  if (!/^[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}$/.test(process.env.SHOP_PAYEE_EMAIL!)) {
    console.error("\nSHOP_PAYEE_EMAIL doesn't look like an email address (it needs an @, with no spaces or quotes). Fix it in .env and run again.");
    process.exit(1);
  }
  return Object.fromEntries(REQUIRED.map((n) => [n, process.env[n]!])) as never;
}

type PayPalResult = { ok: boolean; status: number; body: any; debugId: string | null };

async function call(step: string, path: string, init: RequestInit): Promise<PayPalResult> {
  try {
    const res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw text */ }
    return { ok: res.ok, status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  } catch (err: any) {
    const why = err?.name === "TimeoutError" ? `no answer after ${TIMEOUT_MS / 1000}s` : String(err?.message ?? err);
    throw new Error(`${step}: ${why}`);
  }
}

function explain(step: string, r: PayPalResult): string {
  const b = r.body ?? {};
  const details = Array.isArray(b.details)
    ? b.details.map((d: any) => `${d.issue ?? ""}${d.description ? ` (${d.description})` : ""}`).join("; ")
    : "";
  return `${step} failed: HTTP ${r.status} ${b.name ?? ""} ${b.message ?? ""}${details ? ` | ${details}` : ""}${r.debugId ? ` | debug id ${r.debugId}` : ""}`;
}

async function accessToken(id: string, secret: string): Promise<string> {
  const r = await call("Get access token", "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(explain("Get access token", r));
  return r.body.access_token;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "PayPal-Request-Id": crypto.randomUUID(), // idempotency: a retry never pays twice
    Prefer: "return=representation",
  };
}

async function savePayPal(token: string): Promise<string> {
  const setup = await call("Create setup token", "/v3/vault/setup-tokens", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({
      payment_source: {
        paypal: {
          description: "Agent Shopper: pay for purchases within your limits",
          usage_type: "MERCHANT",
          customer_type: "CONSUMER",
          permit_multiple_payment_tokens: false,
          experience_context: {
            return_url: "https://example.com/returnUrl",
            cancel_url: "https://example.com/cancelUrl",
          },
        },
      },
    }),
  });
  if (!setup.ok) throw new Error(explain("Create setup token", setup));
  const approve = setup.body.links?.find((l: any) => l.rel === "approve")?.href;
  if (!approve) throw new Error("Create setup token: PayPal returned no approval link.");

  console.log("\nStep 1 of 2: save the buyer's PayPal.");
  console.log("Open this link, sign in as your SANDBOX PERSONAL (buyer) account, and agree:");
  console.log(`\n  ${approve}\n`);
  console.log("After agreeing, PayPal sends you to example.com. That page is expected; close it.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter here when done... ");
  rl.close();

  const check = await call("Check setup token", `/v3/vault/setup-tokens/${setup.body.id}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!check.ok) throw new Error(explain("Check setup token", check));
  if (check.body.status !== "APPROVED") {
    throw new Error(`Saved PayPal not approved yet (status ${check.body.status}). Run again and finish the approval.`);
  }

  const saved = await call("Save payment token", "/v3/vault/payment-tokens", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ payment_source: { token: { id: setup.body.id, type: "SETUP_TOKEN" } } }),
  });
  if (!saved.ok) throw new Error(explain("Save payment token", saved));
  console.log(`\nSaved. To skip approval next time, add VAULT_ID=${saved.body.id} to .env`);
  return saved.body.id;
}

type Outcome = { label: string; ok: boolean; detail: string; payee?: string };

async function payWithSavedPayPal(token: string, vaultId: string, label: string, payeeEmail?: string): Promise<Outcome> {
  const unit: any = { amount: { currency_code: "USD", value: AMOUNT }, description: `Payee test: ${label}` };
  if (payeeEmail) unit.payee = { email_address: payeeEmail };

  const order = await call(`${label}: create order`, "/v2/checkout/orders", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({
      intent: "AUTHORIZE",
      purchase_units: [unit],
      payment_source: { paypal: { vault_id: vaultId } },
    }),
  });
  if (!order.ok) return { label, ok: false, detail: explain("Create order", order) };

  // With a saved PayPal there is no buyer approval, so the authorization usually comes back with the order.
  let authId: string | undefined = order.body.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authId) {
    const auth = await call(`${label}: authorize`, `/v2/checkout/orders/${order.body.id}/authorize`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: "{}",
    });
    if (!auth.ok) return { label, ok: false, detail: `Order ${order.body.id} status ${order.body.status}. ${explain("Authorize", auth)}` };
    authId = auth.body.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
  }
  if (!authId) return { label, ok: false, detail: `Order ${order.body.id}: no authorization in PayPal's answer.` };

  // This is where the real app re-checks the price before taking the money.
  const cap = await call(`${label}: capture`, `/v2/payments/authorizations/${authId}/capture`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify({ final_capture: true }),
  });
  if (!cap.ok) return { label, ok: false, detail: `Authorized ${authId}. ${explain("Capture", cap)}` };

  const payee = order.body.purchase_units?.[0]?.payee;
  const to = payee?.email_address ?? payee?.merchant_id ?? "(not shown)";
  const sameAsAsked = !payeeEmail || (payee?.email_address ?? "").toLowerCase() === payeeEmail.toLowerCase();
  return {
    label,
    ok: cap.body.status === "COMPLETED" && sameAsAsked,
    payee: String(payee?.email_address ?? payee?.merchant_id ?? "").toLowerCase(),
    detail: `Order ${order.body.id} -> capture ${cap.body.id} status ${cap.body.status}, paid to ${to}${sameAsAsked ? "" : " (NOT the shop we asked for)"}`,
  };
}

async function main() {
  const env = checkEnv();
  const token = await accessToken(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET);
  console.log("\nConnected to PayPal sandbox.");

  const vaultId = process.env.VAULT_ID || (await savePayPal(token));

  console.log(`\nStep 2 of 2: charge the saved PayPal $${AMOUNT} twice, buyer not present.`);
  const a = await payWithSavedPayPal(token, vaultId, "Test A, pay our own account");
  console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.label}\n        ${a.detail}`);
  const b = await payWithSavedPayPal(token, vaultId, "Test B, pay a different shop", env.SHOP_PAYEE_EMAIL);
  if (a.ok && b.ok && a.payee && a.payee === b.payee) {
    b.ok = false;
    b.detail += `\n        INVALID: this is the same account as Test A (our own app's account).\n        Set SHOP_PAYEE_EMAIL in .env to a DIFFERENT sandbox business account, then run again.`;
  }
  console.log(`  ${b.ok ? "PASS" : "FAIL"}  ${b.label}\n        ${b.detail}`);

  console.log("\nWhat this means:");
  if (a.ok && b.ok) console.log("  The plan works: one saved PayPal can pay any demo shop directly.");
  else if (a.ok && a.payee === b.payee) console.log("  No result yet: Test B paid our own account, so it proved nothing. Fix SHOP_PAYEE_EMAIL and rerun.");
  else if (a.ok) console.log("  Saving and charging work, but paying a different shop was refused. We need a fallback.");
  else console.log("  Charging a saved PayPal failed in sandbox, so Test B tells us nothing yet. Check the error above.");
  console.log("  Check the shop's sandbox business account in the PayPal sandbox site to see the money arrive.");
}

main().catch((err) => {
  console.error(`\nStopped. ${err.message}`);
  process.exit(1);
});
