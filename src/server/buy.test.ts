// End-to-end tests of the buying flow: scripted agent -> real shop pages -> guard -> owner approval ->
// payment service -> shop receives the order. Real Postgres, fake PayPal, no API cost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createPageFetcher } from "../agent/pages.ts";
import type { ModelPort, ShopRef } from "../agent/shopper.ts";
import { SHOPS, findShop } from "../shops/catalog.ts";
import { createShopApp } from "../shops/shop-app.ts";
import { getShopOrder, seedShops, setPriceAdjust } from "../shops/service.ts";
import { pageText } from "../shops/pages.ts";
import { getBalances } from "./balances.ts";
import { approveAndBuy, buyProposal, getSellerStatus, proposeAndBuy, setShopStatus } from "./buy.ts";
import type { BuyDeps } from "./buy.ts";
import { createPool, migrate } from "./db.ts";
import type { Pool } from "./db.ts";
import { FakePayPal } from "./fake-paypal.ts";
import { listLedger } from "./ledger.ts";
import { createMandate } from "./mandates.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set (run: docker start agent-shopper-db, then npm test)";
const schema = `t_${randomBytes(6).toString("hex")}`;
const NOW = new Date("2026-11-11T12:00:00Z");
let admin: Pool | undefined;
let pool: Pool;

before(async () => {
  if (!url) return;
  admin = createPool(url);
  await admin.query(`create schema ${schema}`);
  pool = createPool(url, schema);
  await migrate(pool);
  await seedShops(pool, "shop@example.com");
});

after(async () => {
  if (!url) return;
  await pool.end();
  await admin!.query(`drop schema ${schema} cascade`);
  await admin!.end();
});

const REFS: ShopRef[] = [
  { id: "northgear", baseUrl: "http://northgear.localhost:4101" },
  { id: "deal-zone", baseUrl: "http://deal-zone.localhost:4102" },
  { id: "trailhead", baseUrl: "http://trailhead.localhost:4103" },
];
const N = REFS[0]!.baseUrl;
const Z = REFS[1]!.baseUrl;
const claims = [
  { rule: "item", quote: "Wireless earbuds" },
  { rule: "condition", quote: "Brand new, factory sealed" },
];

// ---- scripted model (same idea as the agent tests) ----
type Params = Anthropic.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;
const use = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const reply = (content: Block[]): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 500, output_tokens: 100 } }) as unknown as Anthropic.Message;
function results(params: Params): Array<{ isError: boolean; data: any }> {
  const last = params.messages.at(-1)!;
  const blocks = Array.isArray(last.content) ? last.content : [];
  return blocks.flatMap((b) => (b.type === "tool_result" ? [{ isError: b.is_error === true, data: JSON.parse(String(b.content)) }] : []));
}
type Turn = (params: Params) => Anthropic.Message | Promise<Anthropic.Message>;
function scripted(turns: Turn[]): ModelPort {
  let n = 0;
  return async (params) => {
    const turn = turns[n++];
    if (!turn) throw new Error("The scripted model ran out of turns.");
    return turn(params);
  };
}
/** The agent opens one product page and proposes it. */
const buyEarbuds = (shopUrl: string): Turn[] => [
  () => reply([use("a", "open_page", { url: `${shopUrl}/products/earbuds` })]),
  (p) => reply([use("b", "propose_purchase", { snapshot_id: results(p)[0]!.data.snapshot_id, reasoning: "Good price.", claims })]),
];
const giveUp: Turn = () => reply([use("z", "give_up", { reason: "Nothing fits." })]);

// ---- the world ----
// Built when a test starts, not when the file loads: the database pool only exists after setup.
const shopApps = () => new Map(REFS.map((r) => [new URL(r.baseUrl).host, createShopApp(pool, findShop(r.id)!, { now: () => NOW })]));
const fetchPage = () => {
  const apps = shopApps();
  return createPageFetcher({
    allowedHosts: [...apps.keys()],
    fetchImpl: (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      return apps.get(u.host)!.request(u.pathname + u.search);
    }) as unknown as typeof fetch,
  });
};
const methods = (fake: FakePayPal): string[] => fake.calls.map((c) => c.method);

async function world(opts: { askAboveCents?: number; shops?: "allowed" | "none" } = {}) {
  const u = await pool.query<{ id: string }>("insert into users (email, paypal_vault_id) values ($1, 'VAULT-1') returning id", [`${randomBytes(4).toString("hex")}@example.com`]);
  const userId = u.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  if ((opts.shops ?? "allowed") === "allowed") for (const s of SHOPS) await setShopStatus(pool, userId, s.id, "allowed");
  const { mandateId } = await createMandate(pool, {
    userId, item: "Wireless earbuds", condition: "new", maxPriceCents: 10000, askAboveCents: opts.askAboveCents ?? 10000,
    deadline: "2027-03-01", sellerMinScore: 70, neverBuy: ["gift cards"], setAsideCents: 10000,
  });
  return { userId, mandateId };
}

function deps(model: ModelPort, paypal = new FakePayPal()): BuyDeps & { paypal: FakePayPal } {
  return { paypal, model, fetchPage: fetchPage(), now: () => NOW };
}
const kinds = async (userId: string) => (await listLedger(pool, userId)).map((r) => r.kind);
const sentAmounts = (paypal: FakePayPal) => paypal.calls.filter((c) => c.method === "authorizeSaved").map((c) => (c.args as { amountCents: number }).amountCents);

test("an allowed request goes all the way: agent, guard, payment, payout, and the shop receives the order", { skip }, async () => {
  const w = await world();
  const d = deps(scripted(buyEarbuds(N)));
  const r = await proposeAndBuy(pool, d, { ...w, shops: REFS });

  assert.equal(r.stage, "purchase");
  if (r.stage !== "purchase") return;
  assert.equal(r.result.status, "paid_out");
  assert.deepEqual(methods(d.paypal), ["authorizeSaved", "capture", "payout"]);
  assert.deepEqual(sentAmounts(d.paypal), [4500]);
  const payout = d.paypal.calls[2]!.args as { receiverEmail: string; amountCents: number };
  assert.equal(payout.receiverEmail, "shop@example.com");
  assert.equal(payout.amountCents, 4500);

  const ledger = await kinds(w.userId);
  for (const k of ["guard_allow", "payment_captured", "payout_sent"] as const) assert.ok(ledger.includes(k), k);
  const prop = (await pool.query("select shop_id, total_cents, decision from proposals where id = $1", [r.proposalId])).rows[0];
  assert.deepEqual(prop, { shop_id: "northgear", total_cents: 4500, decision: "allow" });
  assert.equal((await pool.query("select status from mandates where id = $1", [w.mandateId])).rows[0].status, "fulfilled");
  assert.equal((await getBalances(pool, w.userId, NOW)).monthSpentCents, 4500);

  // The shop was told, and its own page shows the order.
  const orderId = (r.result as { orderId: string }).orderId;
  const shopOrder = (await getShopOrder(pool, orderId))!;
  assert.equal(shopOrder.shopId, "northgear");
  assert.equal(shopOrder.itemKey, "earbuds");
  assert.equal(shopOrder.status, "received");
  assert.equal(shopOrder.promisedBy, "2026-11-15");
  const northgear = createShopApp(pool, findShop("northgear")!, { now: () => NOW });
  const page = pageText(await (await northgear.request(`/orders/${orderId}`)).text());
  assert.match(page, /Wireless earbuds/);
  assert.match(page, /Status Received/);
});

test("above the ask-me limit nothing is charged until the owner approves what they saw", { skip }, async () => {
  const w = await world({ askAboveCents: 4000 });
  const d = deps(scripted(buyEarbuds(N)));
  const r = await proposeAndBuy(pool, d, { ...w, shops: REFS });

  assert.equal(r.stage, "owner");
  if (r.stage !== "owner") return;
  assert.equal(r.totalCents, 4500);
  assert.deepEqual(d.paypal.calls, [], "no PayPal call before approval");
  assert.equal((await pool.query("select count(*)::int as n from orders where mandate_id = $1", [w.mandateId])).rows[0].n, 0);
  assert.equal((await pool.query("select decision from proposals where id = $1", [r.proposalId])).rows[0].decision, "ask");

  // Not approved, or approved for less than the price: still nothing moves.
  const plain = await buyProposal(pool, d, { ...w, proposalId: r.proposalId });
  assert.equal(plain.status, "needs_owner");
  const tooLow = await approveAndBuy(pool, d, { ...w, proposalId: r.proposalId, approvedTotalCents: 4000 });
  assert.equal(tooLow.status, "needs_owner");
  assert.deepEqual(d.paypal.calls, []);

  // Another person cannot approve or buy it.
  const other = await world();
  await assert.rejects(approveAndBuy(pool, d, { userId: other.userId, mandateId: w.mandateId, proposalId: r.proposalId, approvedTotalCents: 4500 }), /Proposal not found/);
  await assert.rejects(approveAndBuy(pool, d, { userId: other.userId, mandateId: other.mandateId, proposalId: r.proposalId, approvedTotalCents: 4500 }), /Proposal not found/);
  assert.deepEqual(d.paypal.calls, []);

  const done = await approveAndBuy(pool, d, { ...w, proposalId: r.proposalId, approvedTotalCents: 4500 });
  assert.equal(done.status, "paid_out");
  assert.deepEqual(methods(d.paypal), ["authorizeSaved", "capture", "payout"]);
  assert.ok((await kinds(w.userId)).includes("owner_approved"));
  assert.ok(await getShopOrder(pool, (done as { orderId: string }).orderId));
});

test("the scam shop is never charged: the agent is turned down there and buys from the honest shop", { skip }, async () => {
  const w = await world();
  const model = scripted([
    () => reply([use("a", "open_page", { url: `${Z}/products/earbuds` })]),
    (p) => reply([use("b", "propose_purchase", { snapshot_id: results(p)[0]!.data.snapshot_id, reasoning: "Cheapest.", claims })]),
    (p) => {
      assert.equal(results(p)[0]!.isError, true);
      return reply([use("c", "open_page", { url: `${N}/products/earbuds` })]);
    },
    (p) => reply([use("d", "propose_purchase", { snapshot_id: results(p)[0]!.data.snapshot_id, reasoning: "Next best.", claims })]),
  ]);
  const d = deps(model);
  const r = await proposeAndBuy(pool, d, { ...w, shops: REFS });
  assert.equal(r.stage, "purchase");
  assert.equal(r.stage === "purchase" && r.result.status, "paid_out");
  assert.deepEqual(sentAmounts(d.paypal), [4500], "only the honest shop's price was ever charged");
  assert.equal(r.run.rejections[0]!.shopId, "deal-zone");
  assert.equal((await pool.query("select count(*)::int as n from proposals where mandate_id = $1", [w.mandateId])).rows[0].n, 1);
  assert.equal((await pool.query("select count(*)::int as n from shop_orders so join orders o on o.id = so.order_id where o.mandate_id = $1 and so.shop_id = 'deal-zone'", [w.mandateId])).rows[0].n, 0);
});

test("the owner's shop list is enforced: unknown shops are refused, ask-every-time asks, allowed buys", { skip }, async () => {
  const w = await world({ shops: "none" });
  assert.equal(await getSellerStatus(pool, w.userId, "northgear"), "unknown");

  // 1. No shops allowed yet: every proposal is turned down and nothing is charged.
  const d1 = deps(scripted([...buyEarbuds(N), (p) => {
    assert.match(results(p)[0]!.data.error, /not on your allowed list/);
    return giveUp(p);
  }]));
  const r1 = await proposeAndBuy(pool, d1, { ...w, shops: REFS });
  assert.equal(r1.stage, "agent");
  assert.deepEqual(d1.paypal.calls, []);

  // 2. Ask every time: the owner is asked even though the price is under the limit.
  await setShopStatus(pool, w.userId, "northgear", "ask_every_time");
  const d2 = deps(scripted(buyEarbuds(N)));
  const r2 = await proposeAndBuy(pool, d2, { ...w, shops: REFS });
  assert.equal(r2.stage, "owner");
  assert.deepEqual(d2.paypal.calls, []);

  // 3. Blocked: refused outright.
  await setShopStatus(pool, w.userId, "northgear", "blocked");
  const d3 = deps(scripted([...buyEarbuds(N), giveUp]));
  assert.equal((await proposeAndBuy(pool, d3, { ...w, shops: REFS })).stage, "agent");
  assert.deepEqual(d3.paypal.calls, []);

  // 4. Allowed: it goes through.
  await setShopStatus(pool, w.userId, "northgear", "allowed");
  const d4 = deps(scripted(buyEarbuds(N)));
  const r4 = await proposeAndBuy(pool, d4, { ...w, shops: REFS });
  assert.equal(r4.stage === "purchase" && r4.result.status, "paid_out");
});

test("if the price rises while the owner is deciding, the approval does not cover it and nothing is charged", { skip }, async () => {
  const w = await world({ askAboveCents: 4000 });
  const d = deps(scripted(buyEarbuds(N)));
  const r = await proposeAndBuy(pool, d, { ...w, shops: REFS });
  assert.equal(r.stage, "owner");
  if (r.stage !== "owner") return;
  try {
    await setPriceAdjust(pool, "northgear", 10);
    const done = await approveAndBuy(pool, d, { ...w, proposalId: r.proposalId, approvedTotalCents: 4500 });
    assert.equal(done.status, "denied");
    if (done.status === "denied") assert.ok(done.checks.some((c) => c.id === "price-same" && c.level === "deny"));
    assert.deepEqual(d.paypal.calls, []);
    assert.equal((await pool.query("select count(*)::int as n from shop_orders so join orders o on o.id = so.order_id where o.mandate_id = $1", [w.mandateId])).rows[0].n, 0);
    assert.equal((await getBalances(pool, w.userId, NOW)).monthSpentCents, 0);
  } finally {
    await setPriceAdjust(pool, "northgear", 0);
  }
});

test("when the agent finds nothing, no order is made and nothing is charged", { skip }, async () => {
  const w = await world();
  const d = deps(scripted([giveUp]));
  const r = await proposeAndBuy(pool, d, { ...w, shops: REFS });
  assert.equal(r.stage, "agent");
  assert.deepEqual(d.paypal.calls, []);
  assert.equal((await pool.query("select count(*)::int as n from orders where mandate_id = $1", [w.mandateId])).rows[0].n, 0);
  assert.equal((await pool.query("select status from mandates where id = $1", [w.mandateId])).rows[0].status, "active");
});

test("buying the same proposal twice charges once", { skip }, async () => {
  const w = await world();
  const d = deps(scripted(buyEarbuds(N)));
  const first = await proposeAndBuy(pool, d, { ...w, shops: REFS });
  assert.equal(first.stage === "purchase" && first.result.status, "paid_out");
  if (first.stage !== "purchase") return;
  await assert.rejects(buyProposal(pool, d, { ...w, proposalId: first.proposalId }), /no longer active/);
  assert.equal(d.paypal.count("authorizeSaved"), 1);
});
