// One real purchase through the PayPal SANDBOX with the real payment service:
// guard -> hold $5.00 on the saved buyer PayPal -> guard again -> take it -> pay the demo shop.
// It uses a throwaway database schema (dropped at the end), so nothing here touches real data.
//
// Run:  node --env-file=.env scripts/payment-smoke.ts
// Needs in .env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, VAULT_ID, SHOP_PAYEE_EMAIL, DATABASE_URL

import { randomBytes } from "node:crypto";
import { createPool, migrate } from "../src/server/db.ts";
import { listLedger } from "../src/server/ledger.ts";
import { createMandate } from "../src/server/mandates.ts";
import { createPayPalClient } from "../src/server/paypal.ts";
import { purchase } from "../src/server/payments.ts";
import type { Proposal } from "../src/shared/types.ts";

const need = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "VAULT_ID", "SHOP_PAYEE_EMAIL", "DATABASE_URL"] as const;
console.log("Settings (names and lengths only):");
let missing = false;
for (const n of need) {
  const v = process.env[n] ?? "";
  console.log(`  ${n}: ${v ? `${v.length} chars` : "MISSING"}`);
  if (!v) missing = true;
}
if (missing) {
  console.error("\nAdd the missing settings to .env, then run again.");
  process.exit(1);
}

const env = process.env as Record<(typeof need)[number], string>;
const schema = `smoke_${randomBytes(4).toString("hex")}`;
const admin = createPool(env.DATABASE_URL);
let pool: ReturnType<typeof createPool> | undefined;

try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(env.DATABASE_URL, schema);
  await migrate(pool);

  const user = await pool.query<{ id: string }>("insert into users (email, paypal_vault_id) values ('smoke@example.com', $1) returning id", [env.VAULT_ID]);
  const userId = user.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  await pool.query("insert into shops (id, name, payout_email) values ('demo-shop', 'Demo shop', $1)", [env.SHOP_PAYEE_EMAIL]);
  const { mandateId } = await createMandate(pool, {
    userId, item: "Smoke test item", condition: "new", maxPriceCents: 2000, askAboveCents: 1500,
    deadline: "2030-01-01", sellerMinScore: 70, neverBuy: [], setAsideCents: 2000,
  });
  const proposal: Proposal = {
    id: "smoke-proposal", sellerId: "demo-shop", itemKey: "smoke", category: "test", totalCents: 500, deliveryBy: "2029-12-01",
    claims: [{ rule: "item", quote: "Smoke test item" }, { rule: "condition", quote: "Brand new, factory sealed" }],
    snapshotText: "Smoke test item. Brand new, factory sealed.", sellerScore: 90,
  };

  const paypal = createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
  console.log("\nBuying one $5.00 item from the sandbox buyer's saved PayPal, then paying the demo shop...");
  const result = await purchase(pool, {
    paypal,
    fetchCurrentTotalCents: async (p) => p.totalCents,
    getSellerStatus: async () => "allowed",
  }, { userId, mandateId, proposal });

  console.log("\nResult:", JSON.stringify(result, null, 2));
  const order = (await pool.query("select status, paypal_order_id, paypal_authorization_id, paypal_capture_id, payout_batch_id, failure from orders")).rows[0];
  console.log("\nOrder row:", JSON.stringify(order, null, 2));
  console.log("\nLedger, oldest first:");
  for (const r of (await listLedger(pool, userId)).reverse()) console.log(`  ${r.kind}${r.amountCents ? `  $${(r.amountCents / 100).toFixed(2)}` : ""}`);
  console.log(result.status === "paid_out" ? "\nPASS: the buyer was charged and the shop was paid." : "\nNOT A FULL PASS: see the result above.");
} catch (err) {
  console.error(`\nStopped. ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
