// ONE real run of the shopper for a plain item request, such as "First aid kit".
// THIS SPENDS REAL MONEY on your Anthropic account: Claude Haiku 5.5, hard-capped at 150,000 tokens,
// which is under $0.08 even at the dearest rate (recent runs cost under 2 cents). It buys nothing and
// never touches PayPal: it only reads the shops and proposes. It makes no retries.
//
// Start the shops and the database first:  npm run shops:local   and   docker start agent-shopper-db
// Run once:   node --env-file=.env scripts/item-live.ts "First aid kit"        (optional second word: most to pay in dollars, default 60)
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

const item = (process.argv[2] ?? "").trim();
const maxDollars = Number(process.argv[3] ?? "60");
if (item.length < 3 || item.length > 80 || !Number.isFinite(maxDollars) || maxDollars < 1 || maxDollars > 500) {
  console.error('Usage: node --env-file=.env scripts/item-live.ts "First aid kit" [most to pay in dollars]');
  process.exit(1);
}

console.log("Settings (names and lengths only):");
for (const n of ["ANTHROPIC_API_KEY", "DATABASE_URL"] as const) {
  const v = process.env[n] ?? "";
  console.log(`  ${n}: ${v ? `${v.length} chars` : "MISSING"}`);
}
if (!process.env["ANTHROPIC_API_KEY"] || !process.env["DATABASE_URL"]) {
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

const schema = `item_${randomBytes(4).toString("hex")}`;
const admin = createPool(process.env["DATABASE_URL"]!);
let pool: ReturnType<typeof createPool> | undefined;
try {
  await admin.query(`create schema ${schema}`);
  pool = createPool(process.env["DATABASE_URL"]!, schema);
  await migrate(pool);
  await seedShops(pool, "shop@example.com");

  const userId = (await pool.query<{ id: string }>("insert into users (email) values ('item-live@example.com') returning id")).rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const maxPriceCents = Math.round(maxDollars * 100);
  const deadline = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
  const input = { userId, item, condition: "new" as const, maxPriceCents, askAboveCents: maxPriceCents, deadline, sellerMinScore: 70, neverBuy: ["gift cards", "crypto", "alcohol"], setAsideCents: maxPriceCents };
  const { mandateId } = await createMandate(pool, input);
  const mandate: Mandate = { id: mandateId, item, condition: "new", maxPriceCents, askAboveCents: maxPriceCents, deadline, sellerMinScore: 70, neverBuyCategories: input.neverBuy };

  console.log(`\nAsking the agent: "${item}", new, up to ${money(maxPriceCents)}, arriving by ${deadline}, shops scoring at least 70.`);
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
    console.log("\nListings the guard turned down:");
    for (const r of run.rejections) console.log(`  ${r.shopId}/${r.itemKey}: ${r.reasons.join(" ")}`);
  }
  console.log("\nOutcome:");
  const o = run.outcome;
  if (o.status === "proposed") {
    const shop = SHOPS.find((s) => s.id === o.proposal.sellerId);
    const name = shop?.products.find((x) => x.key === o.proposal.itemKey)?.name ?? o.proposal.itemKey;
    console.log(`  Proposed ${name} from ${shop?.name} for ${money(o.proposal.totalCents)}, arriving ${o.proposal.deliveryBy}, shop score ${o.proposal.sellerScore}.`);
    console.log(`  The guard says: ${o.guard.decision} (${o.guard.checks.filter((c) => c.level !== "pass").map((c) => c.id).join(", ") || "every check passed"}).`);
    console.log(`  The agent's reasoning: ${o.reasoning}`);
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
