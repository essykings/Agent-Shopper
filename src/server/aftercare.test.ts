// The refund rules and webhook readers, which are plain functions and need no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_PRICE_DROP_CENTS, planPriceDrop, planWrongItem } from "./aftercare.ts";
import { centsFrom } from "./webhooks.ts";

const NOW = new Date("2026-11-11T12:00:00Z");
const daysAgo = (n: number): Date => new Date(NOW.getTime() - n * 86_400_000);
const drop = (over: Partial<Parameters<typeof planPriceDrop>[0]> = {}) =>
  planPriceDrop({ paidCents: 4500, currentCents: 3900, refundedCents: 0, orderedAt: daysAgo(3), now: NOW, windowDays: 14, ...over });

test("a price drop inside the window is owed, and the amount is exactly the difference", () => {
  const p = drop();
  assert.deepEqual([p.eligible, p.amountCents], [true, 600]);
  assert.match(p.reason, /fell from \$45\.00 to \$39\.00, inside the shop's 14-day price protection/);
  assert.equal(drop({ currentCents: 4499 }).eligible, false, "a one-cent drop is not worth a refund");
  assert.equal(drop({ currentCents: 4500 - MIN_PRICE_DROP_CENTS }).eligible, true, "the smallest drop that counts");
  assert.equal(drop({ currentCents: 4500 - MIN_PRICE_DROP_CENTS + 1 }).eligible, false);
  assert.match(drop({ currentCents: 4450 }).reason, /dropped by only \$0\.50, which is below the \$1\.00 minimum/);
});

test("no price refund when the price has not fallen, cannot be read, or the shop offers none", () => {
  assert.match(drop({ currentCents: 4500 }).reason, /has not dropped/);
  assert.match(drop({ currentCents: 5200 }).reason, /has not dropped/);
  assert.match(drop({ currentCents: null }).reason, /could not be read/);
  assert.match(drop({ windowDays: 0 }).reason, /does not offer price protection/);
  assert.equal(drop({ currentCents: 100 }).eligible, true, "a huge drop is still capped, below");
  assert.equal(drop({ currentCents: 100 }).amountCents, 4400);
});

test("the window ends when the shop says it ends, to the day", () => {
  assert.equal(drop({ orderedAt: daysAgo(14) }).eligible, true, "exactly 14 days is still inside");
  assert.equal(drop({ orderedAt: daysAgo(14.01) }).eligible, false);
  assert.match(drop({ orderedAt: daysAgo(30) }).reason, /14-day price protection has ended/);
  assert.equal(drop({ orderedAt: daysAgo(-1) }).eligible, true, "an order dated a little ahead of the clock is not refused");
});

test("a refund is never more than is left of what was paid", () => {
  assert.equal(drop({ currentCents: 100, refundedCents: 4000 }).amountCents, 500, "capped to what is left");
  assert.equal(drop({ currentCents: 100, refundedCents: 4500 }).eligible, false);
  assert.match(drop({ currentCents: 100, refundedCents: 4500 }).reason, /Nothing is left/);
  for (let refunded = 0; refunded <= 4500; refunded += 250) for (const current of [0, 1, 100, 2000, 3900, 4400]) {
    const p = drop({ currentCents: current, refundedCents: refunded });
    assert.ok(p.amountCents <= 4500 - refunded, `${refunded}/${current}`);
    if (!p.eligible) assert.equal(p.amountCents, 0);
  }
});

test("a wrong item is owed in full, once the shop has shipped something that is not what was listed", () => {
  const wrong = (over: Partial<Parameters<typeof planWrongItem>[0]> = {}) =>
    planWrongItem({ paidCents: 4500, refundedCents: 0, shopStatus: "shipped", shippedItem: "Cotton socks, size 8, white", listedName: "Trail socks, 3 pack", ...over });
  const p = wrong();
  assert.deepEqual([p.eligible, p.amountCents], [true, 4500]);
  assert.match(p.reason, /ordered "Trail socks, 3 pack" but .* sent "Cotton socks, size 8, white"/);
  assert.equal(wrong({ shopStatus: "delivered" }).eligible, true);
  assert.equal(wrong({ shopStatus: "received" }).eligible, false, "not shipped yet");
  assert.equal(wrong({ shopStatus: null }).eligible, false);
  assert.match(wrong({ shippedItem: null }).reason, /matches what was listed/);
  assert.deepEqual([wrong({ refundedCents: 600 }).eligible, wrong({ refundedCents: 600 }).amountCents], [true, 3900], "only what is left");
  assert.equal(wrong({ refundedCents: 4500 }).eligible, false);
});

test("amounts in PayPal's events are read as exact cents, and anything odd is rejected", () => {
  assert.equal(centsFrom("5.00"), 500);
  assert.equal(centsFrom("5"), 500);
  assert.equal(centsFrom("5.5"), 550);
  assert.equal(centsFrom("0.07"), 7);
  assert.equal(centsFrom(12.34), 1234);
  assert.equal(centsFrom("1234567.89"), 123456789);
  for (const bad of ["", "-5.00", "0", "0.00", "5.001", "abc", "5,00", "1e3", " 5.00", null, undefined, {}, [], "1234567890.00"]) assert.equal(centsFrom(bad), null, JSON.stringify(bad));
});
