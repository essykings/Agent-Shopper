// Purchase-flow tests: a real Postgres, a fake PayPal. Each run gets its own empty schema.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, migrate } from "./db.ts";
import type { Pool } from "./db.ts";
import { appendLedger, listLedger } from "./ledger.ts";
import { getBalances } from "./balances.ts";
import { createMandate } from "./mandates.ts";
import { MandateNotActiveError, purchase, retryPayout } from "./payments.ts";
import type { PurchaseDeps, PurchaseResult } from "./payments.ts";
import { FakePayPal } from "./fake-paypal.ts";
import type { Proposal, SellerStatus } from "../shared/types.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set (run: docker start agent-shopper-db, then npm test)";
const schema = `t_${randomBytes(6).toString("hex")}`;

let admin: Pool | undefined;
let pool: Pool;

before(async () => {
  if (!url) return;
  admin = createPool(url);
  await admin.query(`create schema ${schema}`);
  pool = createPool(url, schema);
  await migrate(pool);
});

after(async () => {
  if (!url) return;
  await pool.end();
  await admin!.query(`drop schema ${schema} cascade`);
  await admin!.end();
});

const SHOP_EMAIL = "shop@example.com";

async function setup(opts: { totalCents?: number; sellerScore?: number | null; vault?: string | null } = {}) {
  const total = opts.totalCents ?? 20000;
  const user = await pool.query<{ id: string }>("insert into users (email, paypal_vault_id) values ($1, $2) returning id", [
    `${randomBytes(4).toString("hex")}@example.com`,
    opts.vault === undefined ? "VAULT-1" : opts.vault,
  ]);
  const userId = user.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const shopId = `shop_${randomBytes(4).toString("hex")}`;
  await pool.query("insert into shops (id, name, payout_email) values ($1, 'Northgear', $2)", [shopId, SHOP_EMAIL]);
  const { mandateId } = await createMandate(pool, {
    userId,
    item: "PS5 disc edition",
    condition: "new",
    maxPriceCents: 30000,
    askAboveCents: 24000,
    deadline: "2027-03-01",
    sellerMinScore: 70,
    neverBuy: ["gift cards"],
    setAsideCents: 30000,
  });
  const proposal: Proposal = {
    id: `p_${randomBytes(4).toString("hex")}`,
    sellerId: shopId,
    itemKey: "ps5-disc",
    category: "electronics",
    totalCents: total,
    deliveryBy: "2026-11-18",
    claims: [
      { rule: "item", quote: "PS5 disc edition" },
      { rule: "condition", quote: "Brand new, factory sealed" },
    ],
    snapshotText: "PS5 disc edition console. Brand new, factory sealed. Ships in 2 days.",
    sellerScore: opts.sellerScore === undefined ? 86 : opts.sellerScore,
  };
  return { userId, mandateId, shopId, proposal };
}

function depsWith(fake: FakePayPal, over: Partial<PurchaseDeps> = {}): PurchaseDeps {
  return {
    paypal: fake,
    fetchCurrentTotalCents: async (p) => p.totalCents,
    getSellerStatus: async (): Promise<SellerStatus> => "allowed",
    now: () => new Date("2026-11-11T12:00:00Z"),
    ...over,
  };
}

const kinds = async (userId: string) => (await listLedger(pool, userId)).map((r) => r.kind);
const orderOf = async (mandateId: string) => (await pool.query("select * from orders where mandate_id = $1 order by created_at", [mandateId])).rows;
const methods = (fake: FakePayPal) => fake.calls.map((c) => c.method);

function statusOf(r: PurchaseResult): string {
  return r.status;
}

test("a normal purchase: hold, take, pay the shop, and the books balance", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  const result = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });

  assert.equal(result.status, "paid_out");
  assert.deepEqual(methods(fake), ["authorizeSaved", "capture", "payout"]);

  const orders = await orderOf(s.mandateId);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].status, "paid_out");
  assert.equal(orders[0].total_cents, 20000);

  const held = fake.calls[0]!.args as Record<string, unknown>;
  assert.equal(held.vaultId, "VAULT-1");
  assert.equal(held.amountCents, 20000);
  assert.equal(held.customId, orders[0].id);
  assert.equal(held.requestId, `auth-${orders[0].id}`);

  const paid = fake.calls[2]!.args as Record<string, unknown>;
  assert.equal(paid.receiverEmail, SHOP_EMAIL);
  assert.equal(paid.amountCents, 20000);

  const ledger = await listLedger(pool, s.userId);
  const captured = ledger.find((r) => r.kind === "payment_captured")!;
  const sent = ledger.find((r) => r.kind === "payout_sent")!;
  assert.equal(captured.amountCents, 20000);
  assert.equal(sent.amountCents, captured.amountCents);
  assert.ok(ledger.some((r) => r.kind === "guard_allow"));

  const mandate = await pool.query("select status from mandates where id = $1", [s.mandateId]);
  assert.equal(mandate.rows[0].status, "fulfilled");
  const b = await getBalances(pool, s.userId, new Date("2026-11-11T12:00:00Z"));
  assert.equal(b.monthSpentCents, 20000);
  assert.equal(b.setAsideCents, 0);
  assert.equal(b.freeCents, 30000);
});

test("above the ask-me limit nothing moves until the owner approves that exact purchase", { skip }, async () => {
  const s = await setup({ totalCents: 27000 });
  const fake = new FakePayPal();
  const deps = depsWith(fake);
  const base = { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal };

  assert.equal((await purchase(pool, deps, base)).status, "needs_owner");
  assert.equal((await purchase(pool, deps, { ...base, approval: { proposalId: "some-other-proposal", approvedTotalCents: 27000 } })).status, "needs_owner");
  assert.equal((await purchase(pool, deps, { ...base, approval: { proposalId: s.proposal.id, approvedTotalCents: 26000 } })).status, "needs_owner");
  assert.deepEqual(fake.calls, []);
  assert.equal((await orderOf(s.mandateId)).length, 0);
  assert.ok((await kinds(s.userId)).includes("guard_ask"));

  const ok = await purchase(pool, deps, { ...base, approval: { proposalId: s.proposal.id, approvedTotalCents: 27000 } });
  assert.equal(ok.status, "paid_out");
  assert.ok((await kinds(s.userId)).includes("owner_approved"));
  assert.deepEqual(methods(fake), ["authorizeSaved", "capture", "payout"]);
});

test("a denied purchase never reaches PayPal, even with the owner's approval", { skip }, async () => {
  const s = await setup({ sellerScore: 22 });
  const fake = new FakePayPal();
  const approval = { proposalId: s.proposal.id, approvedTotalCents: 99999 };
  const r1 = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  const r2 = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal, approval });
  assert.equal(r1.status, "denied");
  assert.equal(r2.status, "denied");
  assert.deepEqual(fake.calls, []);
  assert.equal((await orderOf(s.mandateId)).length, 0);
  assert.ok((await kinds(s.userId)).includes("guard_deny"));
});

test("if the price rises after the hold, the hold is released and nothing is taken", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  let reads = 0;
  const deps = depsWith(fake, { fetchCurrentTotalCents: async () => (++reads === 1 ? 20000 : 21000) });
  const r = await purchase(pool, deps, { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });

  assert.equal(r.status, "cancelled");
  assert.deepEqual(methods(fake), ["authorizeSaved", "voidAuthorization"]);
  assert.equal((await orderOf(s.mandateId))[0].status, "cancelled");
  assert.ok(!(await kinds(s.userId)).includes("payment_captured"));
  const b = await getBalances(pool, s.userId, new Date("2026-11-11T12:00:00Z"));
  assert.equal(b.monthSpentCents, 0);
  assert.equal(b.setAsideCents, 30000);

  // A cancelled order does not block a later, correct purchase.
  const again = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(again.status, "paid_out");
});

test("if the price cannot be read for the final check, the hold is released", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  let reads = 0;
  const deps = depsWith(fake, { fetchCurrentTotalCents: async () => (++reads === 1 ? 20000 : null) });
  const approval = { proposalId: s.proposal.id, approvedTotalCents: 20000 };
  const r = await purchase(pool, deps, { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal, approval });
  assert.equal(r.status, "cancelled");
  assert.equal(fake.count("capture"), 0);
  assert.equal(fake.count("voidAuthorization"), 1);
});

test("if PayPal refuses the hold, nothing is charged and a later try can work", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  fake.failAuthorize = "no saved PayPal found";
  const r = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /no saved PayPal found/);
  assert.equal(fake.count("capture"), 0);
  assert.equal((await orderOf(s.mandateId))[0].status, "failed");
  assert.ok(!(await kinds(s.userId)).includes("payment_captured"));

  fake.failAuthorize = null;
  assert.equal((await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal })).status, "paid_out");
});

test("if taking the money fails, the hold is released and the request stays open", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  fake.failCapture = "card declined";
  const r = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(r.status, "failed");
  assert.equal(fake.count("voidAuthorization"), 1);
  assert.equal(fake.count("payout"), 0);
  assert.ok(!(await kinds(s.userId)).includes("payment_captured"));
  const mandate = await pool.query("select status from mandates where id = $1", [s.mandateId]);
  assert.equal(mandate.rows[0].status, "active");
});

test("a failed shop payout is retried without charging the buyer again", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  fake.payoutOutcomes = ["failed"];
  const deps = depsWith(fake);
  const first = await purchase(pool, deps, { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(first.status, "payout_failed");
  const orderId = (first as { orderId: string }).orderId;

  // The buyer has been charged and it is on the books, but the shop is not paid yet.
  let ledger = await listLedger(pool, s.userId);
  assert.ok(ledger.some((r) => r.kind === "payment_captured"));
  assert.ok(!ledger.some((r) => r.kind === "payout_sent"));
  assert.equal((await getBalances(pool, s.userId, new Date("2026-11-11T12:00:00Z"))).monthSpentCents, 20000);

  const retried = await retryPayout(pool, deps, orderId);
  assert.equal(retried.status, "paid_out");
  assert.equal(fake.count("authorizeSaved"), 1);
  assert.equal(fake.count("capture"), 1);
  assert.equal(fake.count("payout"), 2);

  const batchIds = fake.calls.filter((c) => c.method === "payout").map((c) => (c.args as { batchId: string }).batchId);
  assert.deepEqual(batchIds, [`payout-${orderId}-1`, `payout-${orderId}-2`]);
  ledger = await listLedger(pool, s.userId);
  assert.equal(ledger.filter((r) => r.kind === "payout_sent").length, 1);
  assert.equal((await orderOf(s.mandateId))[0].status, "paid_out");

  await assert.rejects(retryPayout(pool, deps, orderId), /Only an order with a failed payout/);
  assert.equal(fake.count("payout"), 2);
});

test("a payout that is still processing is recorded as pending", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  fake.payoutOutcomes = ["pending"];
  const r = await purchase(pool, depsWith(fake), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(r.status, "payout_pending");
  assert.equal((await orderOf(s.mandateId))[0].status, "payout_pending");
  assert.ok((await kinds(s.userId)).includes("payment_captured"));
});

test("two buys of the same request at the same moment charge only once", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  fake.authorizeDelayMs = 40;
  const input = { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal };
  const results = await Promise.all([purchase(pool, depsWith(fake), input), purchase(pool, depsWith(fake), input)]);
  assert.equal(results.filter((r) => r.status === "paid_out").length, 1, "exactly one purchase goes through");
  // The other attempt is stopped by one of two safeguards, depending on timing: the guard sees the first
  // order already exists ("denied"), or it loses the race to create its own order ("duplicate").
  const loser = results.find((r) => r.status !== "paid_out")!;
  assert.ok(loser.status === "duplicate" || loser.status === "denied", loser.status);
  if (loser.status === "denied") assert.ok(loser.checks.some((c) => c.id === "duplicate" && c.level === "deny"));
  assert.equal(fake.count("authorizeSaved"), 1);
  assert.equal(fake.count("capture"), 1);
  assert.equal(fake.count("payout"), 1);
  assert.equal((await orderOf(s.mandateId)).length, 1);
});

test("the database itself allows only one live order per request", { skip }, async () => {
  const s = await setup();
  const insert = (status: string) =>
    pool.query(
      "insert into orders (id, user_id, mandate_id, shop_id, proposal_id, total_cents, status) values (gen_random_uuid(), $1, $2, $3, 'p', 20000, $4)",
      [s.userId, s.mandateId, s.shopId, status],
    );
  await insert("failed");
  await insert("cancelled");
  await insert("authorizing");
  await assert.rejects(insert("authorizing"), (err: unknown) => (err as { code?: string }).code === "23505");
  await assert.rejects(insert("paid_out"), (err: unknown) => (err as { code?: string }).code === "23505");
  assert.equal((await orderOf(s.mandateId)).length, 3, "failed and cancelled orders never block a new one, a live one does");
});

test("a request that is already paid cannot be bought again", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  const input = { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal };
  assert.equal((await purchase(pool, depsWith(fake), input)).status, "paid_out");
  await assert.rejects(purchase(pool, depsWith(fake), input), MandateNotActiveError);
  assert.equal(fake.count("authorizeSaved"), 1);
});

test("without a connected PayPal, or for an unknown shop, the purchase stops before anything happens", { skip }, async () => {
  const noPaypal = await setup({ vault: null });
  const fake = new FakePayPal();
  await assert.rejects(purchase(pool, depsWith(fake), { userId: noPaypal.userId, mandateId: noPaypal.mandateId, proposal: noPaypal.proposal }), /PayPal is not connected/);
  const unknown = await setup();
  await assert.rejects(
    purchase(pool, depsWith(fake), { userId: unknown.userId, mandateId: unknown.mandateId, proposal: { ...unknown.proposal, sellerId: "nope" } }),
    /Unknown shop/,
  );
  assert.deepEqual(fake.calls, []);
});

test("a shop that is blocked is refused, and a repeated guard record is stored once", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  const deps = depsWith(fake, { getSellerStatus: async (): Promise<SellerStatus> => "blocked" });
  const input = { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal };
  assert.equal((await purchase(pool, deps, input)).status, "denied");
  assert.equal((await purchase(pool, deps, input)).status, "denied");
  assert.deepEqual(fake.calls, []);
  const denies = (await listLedger(pool, s.userId)).filter((r) => r.kind === "guard_deny");
  assert.equal(denies.length, 1);
});

test("another person's request cannot be bought", { skip }, async () => {
  const mine = await setup();
  const theirs = await setup();
  const fake = new FakePayPal();
  await assert.rejects(purchase(pool, depsWith(fake), { userId: theirs.userId, mandateId: mine.mandateId, proposal: mine.proposal }), /Request not found/);
  assert.deepEqual(fake.calls, []);
  void appendLedger;
});

test("the shop is told after the money is taken and before it is paid, and a failure there does not stop the purchase", { skip }, async () => {
  const s = await setup();
  const fake = new FakePayPal();
  const seen: Array<{ methodsSoFar: string[]; info: unknown }> = [];
  const ok = await purchase(pool, depsWith(fake, { afterCapture: async (info) => { seen.push({ methodsSoFar: methods(fake), info }); } }), { userId: s.userId, mandateId: s.mandateId, proposal: s.proposal });
  assert.equal(ok.status, "paid_out");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0]!.methodsSoFar, ["authorizeSaved", "capture"], "after capture, before payout");
  const orderId = (ok as { orderId: string }).orderId;
  assert.deepEqual(seen[0]!.info, { orderId, userId: s.userId, mandateId: s.mandateId, shopId: s.shopId, itemKey: "ps5-disc", totalCents: 20000 });

  const s2 = await setup();
  const fake2 = new FakePayPal();
  const result = await purchase(pool, depsWith(fake2, { afterCapture: async () => { throw new Error("shop is down"); } }), { userId: s2.userId, mandateId: s2.mandateId, proposal: s2.proposal });
  assert.equal(result.status, "paid_out", "the buyer was charged and the shop paid, so the purchase stands");
  const notes = (await listLedger(pool, s2.userId)).filter((r) => r.kind === "note");
  assert.ok(notes.some((n) => (n.detail as { event?: string }).event === "shop_notify_failed"));

  // A purchase that never captures never tells the shop.
  const s3 = await setup({ sellerScore: 22 });
  let told = 0;
  const denied = await purchase(pool, depsWith(new FakePayPal(), { afterCapture: async () => { told++; } }), { userId: s3.userId, mandateId: s3.mandateId, proposal: s3.proposal });
  assert.equal(denied.status, "denied");
  assert.equal(told, 0);
});
