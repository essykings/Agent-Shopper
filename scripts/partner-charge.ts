// Partner route test (sandbox): can our PLATFORM use a buyer's saved PayPal to pay an onboarded SHOP?
//
// Step 1: the buyer saves PayPal at platform level (usage_type PLATFORM), or we reuse PLATFORM_VAULT_ID.
// Step 2: two charges with nobody present, both paying the shop (payee = its merchant id):
//   Charge 1: intent CAPTURE            (the documented example)
//   Charge 2: intent AUTHORIZE, then capture later (what our guard needs: check price, then take money)
//
// Run:  node --env-file=.env scripts/partner-charge.ts
// Needs in .env: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET, SELLER_MERCHANT_ID
// Optional:      PLATFORM_BN_CODE, PLATFORM_VAULT_ID

import { createInterface } from "node:readline/promises";

const API = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 20_000;
const AMOUNT = "5.00";

const clientId = process.env.PLATFORM_CLIENT_ID ?? "";
const clientSecret = process.env.PLATFORM_CLIENT_SECRET ?? "";
const sellerId = (process.env.SELLER_MERCHANT_ID ?? "").trim();
const bnCode = process.env.PLATFORM_BN_CODE ?? "";

function checkEnv() {
  console.log("Settings (names and lengths only):");
  const rows: [string, string, boolean][] = [
    ["PLATFORM_CLIENT_ID", clientId, true],
    ["PLATFORM_CLIENT_SECRET", clientSecret, true],
    ["SELLER_MERCHANT_ID", sellerId, true],
    ["PLATFORM_BN_CODE", bnCode, false],
    ["PLATFORM_VAULT_ID", process.env.PLATFORM_VAULT_ID ?? "", false],
  ];
  let bad = false;
  for (const [name, v, required] of rows) {
    console.log(`  ${name}: ${v ? `${v.length} chars` : required ? "MISSING" : "not set"}`);
    if (required && !v) bad = true;
  }
  if (sellerId && !/^[2-9A-HJ-NP-Z]{13}$/.test(sellerId)) {
    console.error("\nSELLER_MERCHANT_ID must be 13 letters and digits (the merchantIdInPayPal value). Fix it in .env.");
    process.exit(1);
  }
  if (bad) {
    console.error("\nAdd the missing settings to .env (see .env.example), then run again.");
    process.exit(1);
  }
}

type R = { ok: boolean; status: number; body: any; debugId: string | null };

async function call(step: string, path: string, init: RequestInit): Promise<R> {
  try {
    const res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  } catch (err: any) {
    throw new Error(`${step}: ${err?.name === "TimeoutError" ? `no answer after ${TIMEOUT_MS / 1000}s` : err?.message}`);
  }
}

function explain(step: string, r: R): string {
  const b = r.body ?? {};
  const d = Array.isArray(b.details) ? b.details.map((x: any) => `${x.issue ?? ""}${x.description ? ` (${x.description})` : ""}`).join("; ") : "";
  return `${step} failed: HTTP ${r.status} ${b.name ?? b.error ?? ""} ${b.message ?? b.error_description ?? ""}${d ? ` | ${d}` : ""}${r.debugId ? ` | debug id ${r.debugId}` : ""}`;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64");
// Unsigned JWT, as PayPal documents it: alg none, iss = platform client id, payer_id = the seller.
const assertion = () => `${b64({ alg: "none" })}.${b64({ iss: clientId, payer_id: sellerId })}.`;

function hdr(token: string, withAssertion: boolean): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "PayPal-Request-Id": crypto.randomUUID(),
    Prefer: "return=representation",
  };
  if (bnCode) h["PayPal-Partner-Attribution-Id"] = bnCode;
  if (withAssertion) h["PayPal-Auth-Assertion"] = assertion();
  return h;
}

async function getToken(): Promise<string> {
  const r = await call("Get access token", "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(explain("Get access token", r));
  return r.body.access_token;
}

async function savePayPal(token: string): Promise<string> {
  const body = JSON.stringify({
    customer: { merchant_customer_id: "agent-shopper-buyer-1" },
    payment_source: {
      paypal: {
        description: "Agent Shopper: pay for purchases within your limits",
        usage_type: "PLATFORM",
        customer_type: "CONSUMER",
        usage_pattern: "IMMEDIATE",
        permit_multiple_payment_tokens: false,
        experience_context: { return_url: "https://example.com/returnUrl", cancel_url: "https://example.com/cancelUrl" },
      },
    },
  });
  let setup = await call("Create setup token", "/v3/vault/setup-tokens", { method: "POST", headers: hdr(token, false), body });
  let usedAssertion = false;
  if (!setup.ok) {
    console.log(`  (without the seller header: ${explain("Create setup token", setup)})`);
    setup = await call("Create setup token (with seller header)", "/v3/vault/setup-tokens", { method: "POST", headers: hdr(token, true), body });
    usedAssertion = true;
  }
  if (!setup.ok) throw new Error(explain("Create setup token", setup));
  console.log(`  Setup token created ${usedAssertion ? "with" : "without"} the seller header.`);
  const approve = setup.body.links?.find((l: any) => l.rel === "approve")?.href;
  if (!approve) throw new Error("Create setup token: PayPal returned no approval link.");

  console.log("\nStep 1 of 2: save the buyer's PayPal at platform level.");
  console.log("Open this link, sign in as your SANDBOX PERSONAL (buyer) account, and agree:");
  console.log(`\n  ${approve}\n`);
  console.log("After agreeing, PayPal sends you to example.com. That page is expected; close it.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter here when done... ");
  rl.close();

  const saved = await call("Save payment token", "/v3/vault/payment-tokens", {
    method: "POST",
    headers: hdr(token, usedAssertion),
    body: JSON.stringify({ payment_source: { token: { id: setup.body.id, type: "SETUP_TOKEN" } } }),
  });
  if (!saved.ok) throw new Error(explain("Save payment token", saved));
  console.log(`\nSaved. To skip approval next time, add PLATFORM_VAULT_ID=${saved.body.id} to .env`);
  return saved.body.id;
}

type Outcome = { label: string; ok: boolean; detail: string };

async function charge(token: string, vaultId: string, label: string, intent: "CAPTURE" | "AUTHORIZE"): Promise<Outcome> {
  const order = await call(`${label}: create order`, "/v2/checkout/orders", {
    method: "POST",
    headers: hdr(token, true),
    body: JSON.stringify({
      intent,
      purchase_units: [{ amount: { currency_code: "USD", value: AMOUNT }, description: `Partner test: ${label}`, payee: { merchant_id: sellerId } }],
      payment_source: { paypal: { vault_id: vaultId, attributes: { customer: { merchant_customer_id: "agent-shopper-buyer-1" } } } },
    }),
  });
  if (!order.ok) return { label, ok: false, detail: explain("Create order", order) };

  const pu = order.body.purchase_units?.[0];
  let capture = pu?.payments?.captures?.[0];

  if (intent === "AUTHORIZE") {
    let authId: string | undefined = pu?.payments?.authorizations?.[0]?.id;
    if (!authId) {
      const a = await call(`${label}: authorize`, `/v2/checkout/orders/${order.body.id}/authorize`, { method: "POST", headers: hdr(token, true), body: "{}" });
      if (!a.ok) return { label, ok: false, detail: `Order ${order.body.id} status ${order.body.status}. ${explain("Authorize", a)}` };
      authId = a.body.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;
    }
    if (!authId) return { label, ok: false, detail: `Order ${order.body.id}: no authorization in PayPal's answer.` };
    // This is where the real app re-checks the price before taking the money.
    const c = await call(`${label}: capture`, `/v2/payments/authorizations/${authId}/capture`, { method: "POST", headers: hdr(token, true), body: JSON.stringify({ final_capture: true }) });
    if (!c.ok) return { label, ok: false, detail: `Authorized ${authId}. ${explain("Capture", c)}` };
    capture = c.body;
  } else if (!capture) {
    const c = await call(`${label}: capture`, `/v2/checkout/orders/${order.body.id}/capture`, { method: "POST", headers: hdr(token, true), body: "{}" });
    if (!c.ok) return { label, ok: false, detail: `Order ${order.body.id} status ${order.body.status}. ${explain("Capture", c)}` };
    capture = c.body.purchase_units?.[0]?.payments?.captures?.[0];
  }

  const paidTo = pu?.payee?.merchant_id ?? pu?.payee?.email_address ?? "(not shown)";
  const toShop = paidTo === sellerId;
  return {
    label,
    ok: capture?.status === "COMPLETED" && toShop,
    detail: `Order ${order.body.id} -> capture ${capture?.id ?? "?"} status ${capture?.status ?? "?"}, paid to ${paidTo}${toShop ? " (the shop)" : " (NOT the shop we asked for)"}`,
  };
}

async function main() {
  checkEnv();
  const token = await getToken();
  console.log("\nConnected to PayPal sandbox as the platform app.");
  const vaultId = process.env.PLATFORM_VAULT_ID || (await savePayPal(token));

  console.log(`\nStep 2 of 2: charge the saved PayPal $${AMOUNT} twice, buyer not present, paying the shop.`);
  const a = await charge(token, vaultId, "Charge 1, capture straight away", "CAPTURE");
  console.log(`  ${a.ok ? "PASS" : "FAIL"}  ${a.label}\n        ${a.detail}`);
  const b = await charge(token, vaultId, "Charge 2, authorize then capture", "AUTHORIZE");
  console.log(`  ${b.ok ? "PASS" : "FAIL"}  ${b.label}\n        ${b.detail}`);

  console.log("\nWhat this means:");
  if (a.ok && b.ok) console.log("  The partner route works: one saved PayPal pays the shop directly, with authorize-then-capture.");
  else if (a.ok) console.log("  Paying the shop works, but only with capture straight away. The guard would have to check before creating the order.");
  else console.log("  The shop was not paid. See the error above, then we decide between fixing the call and using the Payouts route.");
  console.log("  Check the shop's sandbox business account on the PayPal sandbox site to see the money arrive.");
}

main().catch((err) => {
  console.error(`\nStopped. ${err.message}`);
  process.exit(1);
});
