// Payouts test (sandbox): can our app pay a demo shop's PayPal account with the Payouts API?
// This is the second half of the "our app is the merchant of record" route:
//   buyer's saved PayPal -> our app (proven by payee-test Test A) -> Payouts -> shop (this test)
//
// Run:  node --env-file=.env scripts/payout-test.ts
// Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (the app whose business account sends the money),
//                SHOP_PAYEE_EMAIL (the demo shop's sandbox business email)

const API = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 20_000;
const AMOUNT = "5.00";

const clientId = process.env.PAYPAL_CLIENT_ID ?? "";
const clientSecret = process.env.PAYPAL_CLIENT_SECRET ?? "";
const shopEmail = (process.env.SHOP_PAYEE_EMAIL ?? "").trim();

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

function checkEnv() {
  console.log("Settings (names and lengths only):");
  for (const [n, v] of [["PAYPAL_CLIENT_ID", clientId], ["PAYPAL_CLIENT_SECRET", clientSecret], ["SHOP_PAYEE_EMAIL", shopEmail]] as const) {
    console.log(`  ${n}: ${v ? `${v.length} chars` : "MISSING"}`);
  }
  if (!clientId || !clientSecret || !shopEmail) {
    console.error("\nAdd the missing settings to .env (see .env.example), then run again.");
    process.exit(1);
  }
  if (!/^[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}$/.test(shopEmail)) {
    console.error("\nSHOP_PAYEE_EMAIL doesn't look like an email address. Fix it in .env and run again.");
    process.exit(1);
  }
}

async function main() {
  checkEnv();
  const tok = await call("Get access token", "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!tok.ok) throw new Error(explain("Get access token", tok));
  const auth = { Authorization: `Bearer ${tok.body.access_token}`, "Content-Type": "application/json" };
  console.log("\nConnected to PayPal sandbox.");

  const batchId = `payout-test-${Date.now()}`;
  const send = await call("Send payout", "/v1/payments/payouts", {
    method: "POST",
    headers: { ...auth, "PayPal-Request-Id": batchId },
    body: JSON.stringify({
      sender_batch_header: { sender_batch_id: batchId, email_subject: "Agent Shopper test payout", email_message: "Sandbox test payment from Agent Shopper." },
      items: [{
        recipient_type: "EMAIL",
        receiver: shopEmail,
        amount: { value: AMOUNT, currency: "USD" },
        note: "Agent Shopper sandbox payout test",
        sender_item_id: `${batchId}-1`,
      }],
    }),
  });
  if (!send.ok) {
    const hint = send.status === 401 || send.status === 403
      ? "\n        Likely meaning: Payouts isn't enabled for this app or its business account. Tick Payouts under the app's features, and if it's ticked, PayPal's docs say access may need to be requested."
      : "";
    console.log(`\n  FAIL  Send payout\n        ${explain("Send payout", send)}${hint}`);
    return finish(false);
  }
  const id = send.body.batch_header?.payout_batch_id;
  console.log(`\n  Payout batch ${id} accepted (status ${send.body.batch_header?.batch_status}). Waiting for PayPal to process it...`);

  let last: R | undefined;
  for (let i = 0; i < 8; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    last = await call("Check payout", `/v1/payments/payouts/${id}`, { method: "GET", headers: auth });
    if (!last.ok) { console.log(`\n  FAIL  Check payout\n        ${explain("Check payout", last)}`); return finish(false); }
    const s = last.body.batch_header?.batch_status;
    if (s && s !== "PENDING" && s !== "PROCESSING") break;
  }
  const item = last?.body.items?.[0];
  const batch = last?.body.batch_header?.batch_status;
  const tx = item?.transaction_status;
  const ok = batch === "SUCCESS" && tx === "SUCCESS";
  console.log(`\n  ${ok ? "PASS" : "FAIL"}  Payout of $${AMOUNT}: batch ${batch}, item ${tx ?? "?"}`);
  if (item?.errors) console.log(`        PayPal says: ${item.errors.name ?? ""} ${item.errors.message ?? ""}`);
  if (tx === "UNCLAIMED") console.log("        UNCLAIMED means the email has no confirmed PayPal account. Check SHOP_PAYEE_EMAIL.");
  if (!ok && (batch === "PENDING" || batch === "PROCESSING")) console.log("        Still processing after 40s. Check the batch again in a minute on the sandbox site.");
  finish(ok);
}

function finish(ok: boolean) {
  console.log("\nWhat this means:");
  console.log(ok
    ? "  Payouts works: our app can pay a demo shop. The merchant-of-record route is possible."
    : "  The shop was not paid. See the message above.");
  console.log("  Check the shop's sandbox business account on the PayPal sandbox site to see the money arrive.");
}

main().catch((err) => {
  console.error(`\nStopped. ${err.message}`);
  process.exit(1);
});
