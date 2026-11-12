// A real run of the shopper agent: the real Claude model browsing the three demo shops.
// THIS SPENDS REAL MONEY on your Anthropic account. It uses Claude Haiku 5.5 by default, which should
// cost a couple of cents per run (not yet measured; the real token count and an estimate are printed
// at the end). Set SHOPPER_MODEL=claude-opus-5-5 in .env to try the larger model. It buys nothing:
// it only reads shop pages and proposes.
//
// Start the shops first:   npm run app:mock      (and the database: docker start agent-shopper-db)
// Then run:                node --env-file=.env scripts/shopper-live.ts
// Needs in .env: ANTHROPIC_API_KEY, DATABASE_URL

import { randomBytes } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { dbGuardFacts } from "../src/agent/facts.ts";
import { createPageFetcher } from "../src/agent/pages.ts";
import { DEFAULT_MODEL, runShopperAgent } from "../src/agent/shopper.ts";
import type { ModelPort, ShopRef } from "../src/agent/shopper.ts";
import { dbStore } from "../src/agent/store.ts";
import { createPool, migrate } from "../src/server/db.ts";
import { createMandate } from "../src/server/mandates.ts";
import { money } from "../src/shops/pages.ts";
import { seedShops } from "../src/shops/service.ts";

// List prices per million tokens (input, output), from the Claude API guide. Haiku 5.5 is cheaper
// for prompts up to 100K tokens, which is what this agent sends. An estimate, not a bill.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-5-5": [4, 20],
};
const MODEL = process.env.SHOPPER_MODEL || DEFAULT_MODEL;

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
  { id: "northgear", baseUrl: "http://localhost:3000/shops/northgear" },
  { id: "deal-zone", baseUrl: "http://localhost:3000/shops/deal-zone" },
  { id: "trailhead", baseUrl: "http://localhost:3000/shops/trailhead" },
];
for (const s of shops) {
  try {
    const r = await fetch(`${s.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
  } catch {
    console.error(`\n${s.id} is not answering at ${s.baseUrl}. Start the app first with: npm run app:mock (the shops are part of it)`);
    process.exit(1);
  }
}

const client = new Anthropic();
const model: ModelPort = (params) => client.messages.create(params);

const schema = `live_${randomBytes(4).toString("hex")}`;
const admin = createPool(process.env.DATABASE_URL);
let pool: ReturnType<typeof createPool> | undefined;
try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(process.env.DATABASE_URL, schema);
  await migrate(pool);
  await seedShops(pool, "shop@example.com");

  const user = await pool.query<{ id: string }>("insert into users (email) values ('live@example.com') returning id");
  const userId = user.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const mandateInput = {
    userId, item: "PS5 disc edition", condition: "new" as const, maxPriceCents: 30000, askAboveCents: 25000,
    deadline: "2027-03-01", sellerMinScore: 70, neverBuy: ["gift cards", "crypto", "alcohol"], setAsideCents: 30000,
  };
  const { mandateId } = await createMandate(pool, mandateInput);
  const mandate = {
    id: mandateId, item: mandateInput.item, condition: mandateInput.condition, maxPriceCents: mandateInput.maxPriceCents,
    askAboveCents: mandateInput.askAboveCents, deadline: mandateInput.deadline, sellerMinScore: mandateInput.sellerMinScore,
    neverBuyCategories: mandateInput.neverBuy,
  };

  console.log(`\nAsking the agent: ${mandate.item}, new, up to ${money(mandate.maxPriceCents)}, shops scoring at least ${mandate.sellerMinScore}.\n`);
  const started = Date.now();
  const run = await runShopperAgent(
    {
      model,
      fetchPage: createPageFetcher({ allowedHosts: ["localhost:3000"], allowedPrefixes: shops.map((s) => s.baseUrl) }),
      store: dbStore(pool),
      getGuardFacts: dbGuardFacts(pool, { userId, mandateId, getSellerStatus: async () => "allowed" }),
      modelName: MODEL,
    },
    { mandate, shops },
  );

  console.log("What the agent did:");
  for (const a of run.actions) console.log(`  ${a.ok ? "✓" : "✗"} ${a.summary}`);
  if (run.rejections.length) {
    console.log("\nListings the guard turned down:");
    for (const r of run.rejections) console.log(`  ${r.shopId}/${r.itemKey}: ${r.reasons.join(" ")}`);
  }
  console.log("\nOutcome:");
  const o = run.outcome;
  if (o.status === "proposed") {
    console.log(`  Proposed ${o.proposal.itemKey} from ${o.proposal.sellerId} for ${money(o.proposal.totalCents)}, arriving ${o.proposal.deliveryBy}.`);
    console.log(`  Shop score ${o.proposal.sellerScore}. The guard says: ${o.guard.decision}.`);
    console.log(`  The agent's reasoning: ${o.reasoning}`);
  } else {
    console.log(`  ${JSON.stringify(o)}`);
  }
  const price = PRICES[MODEL];
  const cost = price ? `Estimated cost: about $${((run.usage.inputTokens / 1e6) * price[0] + (run.usage.outputTokens / 1e6) * price[1]).toFixed(3)}.` : "No price on file for this model, so no cost estimate.";
  console.log(`\nModel ${MODEL}: ${run.steps} turns in ${((Date.now() - started) / 1000).toFixed(0)}s. Tokens: ${run.usage.inputTokens} in, ${run.usage.outputTokens} out. ${cost}`);
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
