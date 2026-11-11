// ONE real refund through the PayPal SANDBOX, using the real aftercare code.
//
// What it does, all against the sandbox (no real money):
//   1. holds and takes $45.00 from the sandbox buyer's saved PayPal   (a real payment, needed so there is something to refund)
//   2. the demo shop drops its price by 15%, and the aftercare code opens a price-drop case for the $6.00 difference
//   3. the real refund code refunds that $6.00 through PayPal
//   4. asks PayPal itself, by its API, whether the refund exists and what it says
// It does not pay the shop, makes no repeat refund, and uses a throwaway database schema that is dropped at the end.
//
// Run once:  node --env-file=.env scripts/refund-live.ts
// Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, VAULT_ID (or DEMO_VAULT_ID), SHOP_PAYEE_EMAIL, DATABASE_URL

import { randomBytes, randomUUID } from "node:crypto";
import { createPageFetcher } from "../src/agent/pages.ts";
import { checkOrders, refundCase } from "../src/server/aftercare.ts";
import { createPool, migrate } from "../src/server/db.ts";
import { appendLedger, listLedger } from "../src/server/ledger.ts";
import { createMandate } from "../src/server/mandates.ts";
import { createPayPalClient } from "../src/server/paypal.ts";
import { findShop } from "../src/shops/catalog.ts";
import { createShopApp } from "../src/shops/shop-app.ts";
import { receiveOrder, seedShops, setPriceAdjust } from "../src/shops/service.ts";

const vault = process.env["VAULT_ID"] || process.env["DEMO_VAULT_ID"] || "";
const settings: Array<[string, string]> = [
  ["PAYPAL_CLIENT_ID", process.env["PAYPAL_CLIENT_ID"] ?? ""],
  ["PAYPAL_CLIENT_SECRET", process.env["PAYPAL_CLIENT_SECRET"] ?? ""],
  ["VAULT_ID or DEMO_VAULT_ID", vault],
  ["SHOP_PAYEE_EMAIL", process.env["SHOP_PAYEE_EMAIL"] ?? ""],
  ["DATABASE_URL", process.env["DATABASE_URL"] ?? ""],
];
console.log("Settings (names and lengths only):");
for (const [n, v] of settings) console.log(`  ${n}: ${v ? `${v.length} chars` : "MISSING"}`);
if (settings.some(([, v]) => !v)) {
  console.error("\nAdd the missing settings to .env, then run again.");
  process.exit(1);
}
const clientId = process.env["PAYPAL_CLIENT_ID"]!;
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"]!;
const base = "https://api-m.sandbox.paypal.com";

/** Asks PayPal directly (not through our own code) what it has on record. */
async function askPayPal(path: string): Promise<any> {
  const t = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20_000),
  });
  const token = ((await t.json()) as { access_token: string }).access_token;
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const schema = `refund_${randomBytes(4).toString("hex")}`;
const admin = createPool(process.env["DATABASE_URL"]!);
let pool: ReturnType<typeof createPool> | undefined;
const dollars = (c: number): string => `$${(c / 100).toFixed(2)}`;

try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(process.env["DATABASE_URL"]!, schema);
  await migrate(pool);
  await seedShops(pool, process.env["SHOP_PAYEE_EMAIL"]!);

  const userId = (await pool.query<{ id: string }>("insert into users (email, paypal_vault_id) values ('refund-live@example.com', $1) returning id", [vault])).rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const { mandateId } = await createMandate(pool, { userId, item: "Wireless earbuds", condition: "new", maxPriceCents: 10000, askAboveCents: 10000, deadline: "2030-01-01", sellerMinScore: 70, neverBuy: [], setAsideCents: 10000 });

  // 1. A real payment: hold, then take, $45.00 on the saved sandbox buyer.
  const paypal = createPayPalClient({ clientId, clientSecret });
  const orderId = randomUUID();
  console.log("\nStep 1: charging the sandbox buyer $45.00 (a real sandbox payment, so there is something to refund)...");
  const held = await paypal.authorizeSaved({ vaultId: vault, amountCents: 4500, requestId: `auth-${orderId}`, description: "Aftercare refund test", customId: orderId });
  const { captureId } = await paypal.capture({ authorizationId: held.authorizationId, requestId: `cap-${orderId}` });
  console.log(`  captured. capture id ${captureId}`);

  await pool.query(
    "insert into orders (id, user_id, mandate_id, shop_id, proposal_id, total_cents, status, paypal_order_id, paypal_authorization_id, paypal_capture_id) values ($1, $2, $3, 'northgear', 'live-refund-proposal', 4500, 'captured', $4, $5, $6)",
    [orderId, userId, mandateId, held.orderId, held.authorizationId, captureId],
  );
  await appendLedger(pool, { userId, mandateId, kind: "payment_captured", amountCents: 4500, idempotencyKey: `capture:${orderId}`, detail: { orderId, captureId, shopId: "northgear" } });
  await pool.query("update mandates set status = 'fulfilled' where id = $1", [mandateId]);
  await receiveOrder(pool, { orderId, shopId: "northgear", itemKey: "earbuds" });

  // 2. The shop drops its price. The shop and its pages run inside this script, not over the network.
  await setPriceAdjust(pool, "northgear", -15);
  const shop = createShopApp(pool, findShop("northgear")!);
  const host = "northgear.localhost:4101";
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    return shop.request(u.pathname + u.search);
  }) as unknown as typeof fetch;
  const deps = { paypal, fetchPage: createPageFetcher({ allowedHosts: [host], fetchImpl }), shops: [{ id: "northgear", baseUrl: `http://${host}` }] };

  console.log("\nStep 2: the shop's price dropped by 15%. Checking the order for problems...");
  const cases = await checkOrders(pool, deps, userId);
  for (const c of cases) console.log(`  case: ${c.kind}, ${c.status}, ${dollars(c.amountCents)}. ${c.summary}`);
  const drop = cases.find((c) => c.kind === "price_drop");
  if (!drop) throw new Error("No price-drop case was opened, so there is nothing to refund. Nothing was refunded.");

  // 3. The one real refund.
  console.log(`\nStep 3: the owner presses "refund me" on the ${dollars(drop.amountCents)} case. One real refund request goes to PayPal...`);
  const result = await refundCase(pool, deps, { userId, caseId: drop.id });
  console.log("  result:", JSON.stringify(result));

  // 4. What PayPal itself says.
  if (result.status === "refunded") {
    console.log("\nStep 4: asking PayPal directly what it has on record...");
    const refund = await askPayPal(`/v2/payments/refunds/${result.refundId}`);
    console.log(`  refund ${result.refundId}: HTTP ${refund.status}, status ${refund.body.status}, amount ${refund.body.amount?.value} ${refund.body.amount?.currency_code}`);
    console.log(`  custom_id on the refund: ${refund.body.custom_id === drop.id ? "matches our case id" : `DOES NOT MATCH (${refund.body.custom_id})`}`);
    console.log(`  note to payer: ${refund.body.note_to_payer ?? "(none)"}`);
    const cap = await askPayPal(`/v2/payments/captures/${captureId}`);
    console.log(`  the payment: HTTP ${cap.status}, status ${cap.body.status}, amount ${cap.body.amount?.value}`);
    console.log(`  refunded so far (PayPal's breakdown): ${cap.body.seller_receivable_breakdown?.total_refunded_amount?.value ?? "(not shown)"}`);
    const ours = (await pool.query("select refunded_cents from orders where id = $1", [orderId])).rows[0].refunded_cents;
    console.log(`\nOur books: order refunded ${dollars(ours)}.`);
    console.log("Ledger, oldest first:");
    for (const r of (await listLedger(pool, userId)).reverse()) console.log(`  ${r.kind}${r.amountCents ? `  ${dollars(r.amountCents)}` : ""}`);
    const agrees = refund.body.status === "COMPLETED" && refund.body.amount?.value === "6.00" && ours === 600;
    console.log(agrees ? "\nPASS: PayPal shows a completed $6.00 refund, and our books agree." : "\nNOT A CLEAN PASS: compare PayPal's answer above with ours.");
  } else {
    console.log("\nNo refund was made. See the result above.");
  }
} catch (err) {
  console.error(`\nStopped. ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
