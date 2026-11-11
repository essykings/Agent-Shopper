// ONE real gift run: the real Claude model (Haiku 5.5) shopping the three local demo shops for a gift.
// THIS SPENDS REAL MONEY on your Anthropic account, a few cents at most: the run is hard-capped at
// 150,000 tokens, which costs under $0.08 even if every token were the dearest kind. It buys nothing and
// never touches PayPal: it only reads shop pages and suggests ideas. It makes no retries.
//
// Start the shops and the database first:  npm run shops:local   and   docker start agent-shopper-db
// Then run once:                           node --env-file=.env scripts/gift-live.ts
// Needs in .env: ANTHROPIC_API_KEY, DATABASE_URL

import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { dbGuardFacts } from "../src/agent/facts.ts";
import { createPageFetcher } from "../src/agent/pages.ts";
import { costMicroUsd } from "../src/agent/pricing.ts";
import { DEFAULT_MODEL, runShopperAgent } from "../src/agent/shopper.ts";
import type { ModelPort, ShopRef } from "../src/agent/shopper.ts";
import { dbStore } from "../src/agent/store.ts";
import { createPool, migrate } from "../src/server/db.ts";
import { createMandate } from "../src/server/mandates.ts";
import type { Mandate } from "../src/shared/types.ts";
import { SHOPS } from "../src/shops/catalog.ts";
import { money } from "../src/shops/pages.ts";
import { seedShops } from "../src/shops/service.ts";

const MODEL = DEFAULT_MODEL;
const TOKEN_CAP = 150_000;

console.log("Settings (names and lengths only):");
for (const n of ["ANTHROPIC_API_KEY", "DATABASE_URL"] as const) {
  const v = process.env[n] ?? "";
  console.log(`  ${n}: ${v ? `${v.length} chars` : "MISSING"}`);
}
if (!process.env.ANTHROPIC_API_KEY || !process.env.DATABASE_URL) {
  console.error("\nAdd the missing settings to .env, then run again.");
  process.exit(1);
}

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

const client = new Anthropic({ maxRetries: 0 });
let calls = 0;
const model: ModelPort = (params) => {
  calls++;
  return client.messages.create(params);
};

const schema = `gift_${randomBytes(4).toString("hex")}`;
const admin = createPool(process.env.DATABASE_URL);
let pool: ReturnType<typeof createPool> | undefined;
try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(process.env.DATABASE_URL, schema);
  await migrate(pool);
  await seedShops(pool, "shop@example.com");

  const userId = (await pool.query<{ id: string }>("insert into users (email) values ('gift-live@example.com') returning id")).rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const goal = { recipient: "Dad", occasion: "Christmas", interests: "hiking, coffee, camping" };
  const deadline = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const input = { userId, item: `Gift for ${goal.recipient}: ${goal.occasion}`, condition: "new" as const, maxPriceCents: 12000, askAboveCents: 12000, deadline, sellerMinScore: 70, neverBuy: ["gift cards", "crypto", "alcohol"], setAsideCents: 12000, kind: "gift" as const, goal };
  const { mandateId } = await createMandate(pool, input);
  const mandate: Mandate = { id: mandateId, item: input.item, condition: "new", maxPriceCents: 12000, askAboveCents: 12000, deadline, sellerMinScore: 70, neverBuyCategories: input.neverBuy, kind: "gift", goal };

  console.log(`\nAsking the agent: a ${goal.occasion} gift for ${goal.recipient} (likes ${goal.interests}), new, up to ${money(mandate.maxPriceCents)}, arriving by ${deadline}, shops scoring at least 70.`);
  console.log(`Model ${MODEL}, capped at ${TOKEN_CAP} tokens. One run.\n`);
  const started = Date.now();
  const run = await runShopperAgent(
    {
      model,
      fetchPage: createPageFetcher({ allowedHosts: shops.map((s) => new URL(s.baseUrl).host) }),
      store: dbStore(pool),
      getGuardFacts: dbGuardFacts(pool, { userId, mandateId, getSellerStatus: async () => "allowed" }),
      modelName: MODEL,
      maxTotalTokens: TOKEN_CAP,
    },
    { mandate, shops },
  );

  console.log("What the agent did:");
  for (const a of run.actions) console.log(`  ${a.ok ? "✓" : "✗"} ${a.summary}`);
  if (run.rejections.length) {
    console.log("\nIdeas the guard turned down:");
    for (const r of run.rejections) console.log(`  ${r.shopId}/${r.itemKey}: ${r.reasons.join(" ")}`);
  }
  console.log("\nOutcome:");
  const o = run.outcome;
  if (o.status === "shortlist") {
    console.log(`  ${o.picks.length} idea(s). The agent says: ${o.summary}`);
    for (const [i, p] of o.picks.entries()) {
      const shop = SHOPS.find((s) => s.id === p.proposal.sellerId);
      const name = shop?.products.find((x) => x.key === p.proposal.itemKey)?.name ?? p.proposal.itemKey;
      console.log(`\n  Idea ${i + 1}: ${name} (${p.proposal.category}) from ${shop?.name}, ${money(p.proposal.totalCents)}, arrives ${p.proposal.deliveryBy}, shop score ${p.proposal.sellerScore}`);
      console.log(`    Guard: ${p.guard.decision} (${p.guard.checks.filter((c) => c.level !== "pass").map((c) => c.id).join(", ") || "all passed"})`);
      console.log(`    Why: ${p.reasoning}`);
    }
  } else {
    console.log(`  ${JSON.stringify(o)}`);
  }
  const usd = costMicroUsd(MODEL, run.usage) / 1e6;
  console.log(`\n${run.steps} turns, ${calls} model calls, ${((Date.now() - started) / 1000).toFixed(0)}s. Tokens: ${run.usage.inputTokens} in, ${run.usage.outputTokens} out. Estimated cost: about $${usd.toFixed(3)} (an estimate, not a bill).`);
} catch (err) {
  if (err instanceof Anthropic.AuthenticationError) console.error("\nStopped. Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env.");
  else if (err instanceof Anthropic.RateLimitError) console.error("\nStopped. Anthropic says you are sending too many requests. Wait a minute and run again.");
  else if (err instanceof Anthropic.APIError) console.error(`\nStopped. Anthropic returned an error (${err.status}): ${err.message}`);
  else console.error(`\nStopped. ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await pool?.end();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
