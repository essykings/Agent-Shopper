// The whole flow for real: the Haiku agent browses the three demo shops, the guard checks its proposal,
// and the payment service charges the saved sandbox buyer PayPal, pays the shop, and tells the shop.
//
// THIS MOVES SANDBOX MONEY and SPENDS REAL MONEY on your Anthropic account (a fraction of a cent to a
// few cents). The PayPal side is the sandbox only: no real funds. It buys earbuds ($45.00 at the honest
// shop; the scam shop lists them at $29.00 and must be refused).
//
// Start the shops and database first:  docker start agent-shopper-db && npm run shops:local
// Run:                                 node --env-file=.env scripts/buy-live.ts
// Options:  --ask       make the ask-me limit low, so the owner has to approve
//           --approve   with --ask, approve automatically (otherwise it stops and says what it is waiting for)
// Needs in .env: ANTHROPIC_API_KEY, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, VAULT_ID, SHOP_PAYEE_EMAIL, DATABASE_URL

import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createPageFetcher } from "../src/agent/pages.ts";
import { DEFAULT_MODEL } from "../src/agent/shopper.ts";
import type { ModelPort, ShopRef } from "../src/agent/shopper.ts";
import { approveAndBuy, proposeAndBuy, setShopStatus } from "../src/server/buy.ts";
import { createPool, migrate } from "../src/server/db.ts";
import { listLedger } from "../src/server/ledger.ts";
import { createMandate } from "../src/server/mandates.ts";
import { createPayPalClient } from "../src/server/paypal.ts";
import { money } from "../src/shops/pages.ts";
import { getShopOrder, seedShops } from "../src/shops/service.ts";

const need = ["ANTHROPIC_API_KEY", "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "VAULT_ID", "SHOP_PAYEE_EMAIL", "DATABASE_URL"] as const;
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
const forceAsk = process.argv.includes("--ask");
const autoApprove = process.argv.includes("--approve");
const MODEL = process.env.SHOPPER_MODEL || DEFAULT_MODEL;

const shops: ShopRef[] = [
  { id: "northgear", baseUrl: "http://northgear.localhost:4101" },
  { id: "deal-zone", baseUrl: "http://deal-zone.localhost:4102" },
  { id: "trailhead", baseUrl: "http://trailhead.localhost:4103" },
];
for (const s of shops) {
  try {
    const r = await fetch(`${s.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch {
    console.error(`\n${s.id} is not answering at ${s.baseUrl}. Start the shops with: npm run shops:local`);
    process.exit(1);
  }
}

const client = new Anthropic();
const model: ModelPort = (params) => client.messages.create(params);
const paypal = createPayPalClient({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET });
const fetchPage = createPageFetcher({ allowedHosts: shops.map((s) => new URL(s.baseUrl).host) });

const schema = `buy_${randomBytes(4).toString("hex")}`;
const admin = createPool(env.DATABASE_URL);
let pool: ReturnType<typeof createPool> | undefined;
try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(env.DATABASE_URL, schema);
  await migrate(pool);
  await seedShops(pool, env.SHOP_PAYEE_EMAIL);

  const u = await pool.query<{ id: string }>("insert into users (email, paypal_vault_id) values ('buy-live@example.com', $1) returning id", [env.VAULT_ID]);
  const userId = u.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  for (const s of shops) await setShopStatus(pool, userId, s.id, "allowed");
  const { mandateId } = await createMandate(pool, {
    userId, item: "Wireless earbuds", condition: "new", maxPriceCents: 10000, askAboveCents: forceAsk ? 4000 : 10000,
    deadline: "2030-01-01", sellerMinScore: 70, neverBuy: ["gift cards", "crypto", "alcohol"], setAsideCents: 10000,
  });

  console.log(`\nRequest: wireless earbuds, new, up to ${money(10000)}, ask me above ${money(forceAsk ? 4000 : 10000)}. Model: ${MODEL}.\n`);
  const deps = { paypal, model, fetchPage, modelName: MODEL };
  const r = await proposeAndBuy(pool, deps, { userId, mandateId, shops });

  console.log("What the agent did:");
  for (const a of r.run.actions) console.log(`  ${a.ok ? "✓" : "✗"} ${a.summary}`);
  for (const rej of r.run.rejections) console.log(`  Turned down: ${rej.shopId}/${rej.itemKey}: ${rej.reasons.join(" ")}`);

  let orderId: string | null = null;
  if (r.stage === "agent") {
    console.log(`\nNo purchase: ${JSON.stringify(r.outcome)}`);
  } else if (r.stage === "owner") {
    console.log(`\nThe agent proposed ${money(r.totalCents)} and the owner has to approve it before anything is charged.`);
    if (autoApprove) {
      console.log("Approving automatically (--approve)...");
      const done = await approveAndBuy(pool, deps, { userId, mandateId, proposalId: r.proposalId, approvedTotalCents: r.totalCents });
      console.log(`Payment result: ${JSON.stringify(done)}`);
      if ("orderId" in done) orderId = done.orderId;
    } else {
      console.log("Stopping here. Run again with --approve to approve it.");
    }
  } else {
    console.log(`\nPayment result: ${JSON.stringify(r.result)}`);
    if ("orderId" in r.result) orderId = r.result.orderId;
  }

  if (orderId) {
    const shopOrder = await getShopOrder(pool, orderId);
    console.log(`\nThe shop's record: ${shopOrder ? `${shopOrder.shopId} received ${shopOrder.itemKey}, promised by ${shopOrder.promisedBy}` : "NO ORDER RECORDED AT THE SHOP"}`);
  }
  console.log("\nLedger, oldest first:");
  for (const row of (await listLedger(pool, userId)).reverse()) console.log(`  ${row.kind}${row.amountCents ? `  ${money(row.amountCents)}` : ""}`);
  console.log(`\nAgent: ${r.run.steps} turns, ${r.run.usage.inputTokens} tokens in, ${r.run.usage.outputTokens} out.`);
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("\nStopped. Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.");
  else if (err instanceof Anthropic.APIError) console.error(`\nStopped. Anthropic returned an error (${err.status}): ${err.message}`);
  else console.error(`\nStopped. ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
