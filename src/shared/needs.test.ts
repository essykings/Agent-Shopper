import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeCount, needsYou, shortStep, visibleNeeds } from "./needs.ts";
import type { NeedItem, NeedsCase, NeedsInput, NeedsRequest } from "./needs.ts";

const request = (over: Partial<NeedsRequest> = {}): NeedsRequest => ({ id: "r1", item: "Wireless earbuds", status: "active", hasOrder: false, ideas: 0, approval: null, recipient: null, ...over });
const refund = (over: Partial<NeedsCase> = {}): NeedsCase => ({ id: "c1", orderId: "o1", kind: "price_drop", status: "open", amountCents: 600, itemName: "Wireless earbuds", shopName: "Northgear", ...over });
const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({ paused: false, paymentSource: "demo", requests: [], cases: [], working: null, ...over });
const kinds = (items: NeedItem[]) => items.map((i) => i.kind);

test("when nothing is waiting there is nothing to show", () => {
  assert.deepEqual(needsYou(input()), []);
  assert.deepEqual(needsYou(input({ requests: [request({ status: "fulfilled", hasOrder: true }), request({ id: "r2", status: "cancelled" })] })), []);
});

test("a request that has not been run yet is 'ready', and several are counted", () => {
  const one = needsYou(input({ requests: [request()] }));
  assert.deepEqual(kinds(one), ["ready"]);
  assert.equal(one[0]!.text, "Ready to run: Wireless earbuds.");
  assert.deepEqual(one[0]!.action, { label: "Go to my requests", href: "#/" });
  const many = needsYou(input({ requests: [request(), request({ id: "r2", item: "Daypack" }), request({ id: "r3", item: "Kettle" })] }));
  assert.deepEqual([many.length, many[0]!.text], [1, "3 requests are ready to run."]);
});

test("gift ideas waiting are said in words, with who they are for, and singular or plural", () => {
  const two = needsYou(input({ requests: [request({ id: "g1", item: "Gift for Dad: Christmas", ideas: 2, recipient: "Dad" })] }));
  assert.deepEqual(kinds(two), ["ideas"]);
  assert.equal(two[0]!.text, "Your shopper found 2 gift ideas for Dad. Nothing is bought until you choose.");
  assert.deepEqual(two[0]!.action, { label: "See the 2 ideas", href: "#/approve/g1" });
  const one = needsYou(input({ requests: [request({ id: "g2", ideas: 1 })] }));
  assert.equal(one[0]!.text, "Your shopper found 1 gift idea. Nothing is bought until you choose.");
  assert.deepEqual(one[0]!.action, { label: "See the idea", href: "#/approve/g2" });
});

test("a purchase that needs the owner's OK names the item, the price and the shop", () => {
  const items = needsYou(input({ requests: [request({ id: "a1", approval: { itemName: "Wireless earbuds", shopName: "Northgear", totalCents: 4500 } })] }));
  assert.deepEqual(kinds(items), ["approval"]);
  assert.equal(items[0]!.text, "Your shopper wants to buy Wireless earbuds for $45.00 from Northgear. It needs your OK first.");
  assert.deepEqual(items[0]!.action, { label: "Review and approve", href: "#/approve/a1" });
  assert.deepEqual(kinds(needsYou(input({ requests: [request({ ideas: 2, approval: { itemName: "x", shopName: "y", totalCents: 100 } })] }))), ["ideas"], "one item per request");
});

test("a request that is already bought or cancelled never asks for anything", () => {
  const items = needsYou(input({ requests: [request({ hasOrder: true, ideas: 2 }), request({ id: "r2", status: "cancelled", approval: { itemName: "x", shopName: "y", totalCents: 100 } })] }));
  assert.deepEqual(items, []);
});

test("a refund the owner can claim is offered, with the larger claim when one order has two", () => {
  const price = needsYou(input({ cases: [refund()] }));
  assert.equal(price[0]!.text, "Northgear dropped its price on Wireless earbuds. You can claim $6.00.");
  assert.deepEqual(price[0]!.action, { label: "Review the refund", href: "#/orders" });
  const both = needsYou(input({ cases: [refund(), refund({ id: "c2", kind: "wrong_item", amountCents: 4500 })] }));
  assert.equal(both.length, 1, "two claims on one payment show once");
  assert.equal(both[0]!.text, "Northgear sent the wrong item for Wireless earbuds. You can claim $45.00.");
  const separate = needsYou(input({ cases: [refund(), refund({ id: "c3", orderId: "o2", itemName: "Daypack", amountCents: 900 })] }));
  assert.equal(separate.length, 2, "different orders show separately");
});

test("only open price-drop and wrong-item cases count: refunded, declined and disputes do not", () => {
  const cases = [refund({ status: "refunded" }), refund({ id: "c2", status: "declined" }), refund({ id: "c3", status: "expired" }), refund({ id: "c4", kind: "dispute" }), refund({ id: "c5", status: "closed" })];
  assert.deepEqual(needsYou(input({ cases })), []);
});

test("no PayPal account matters only when something could be bought, and a paused shopper can be resumed", () => {
  assert.deepEqual(needsYou(input({ paymentSource: "none" })), [], "nothing to buy, so no nagging");
  const blocked = needsYou(input({ paymentSource: "none", requests: [request()] }));
  assert.deepEqual(kinds(blocked), ["payment", "ready"]);
  assert.deepEqual(blocked[0]!.action, { label: "Connect PayPal", href: "#/wallet" });
  const paused = needsYou(input({ paused: true }));
  assert.deepEqual(kinds(paused), ["paused"]);
  assert.deepEqual(paused[0]!.action, { label: "Resume", run: "resume" });
});

test("a shopper at work comes first, says what it is doing, and offers the Town", () => {
  const items = needsYou(input({ working: { step: "Reading Wireless earbuds at Northgear", seconds: 14 }, requests: [request({ ideas: 2 })], paused: true }));
  assert.deepEqual(kinds(items), ["working", "paused", "ideas"]);
  assert.equal(items[0]!.text, "Your shopper is looking at the shops…");
  assert.equal(items[0]!.sub, "Reading Wireless earbuds at Northgear · 14s");
  assert.deepEqual(items[0]!.action, { label: "Watch it live", href: "#/town" });
  assert.equal(needsYou(input({ working: { step: "", seconds: 3 } }))[0]!.sub, "3s", "no step yet: only the time");
});

test("the order is: working, then what blocks buying, then what needs a decision, then refunds, then 'ready'", () => {
  const items = needsYou(input({
    working: { step: "", seconds: 1 }, paused: true, paymentSource: "none",
    requests: [request({ id: "a", ideas: 2 }), request({ id: "b", approval: { itemName: "x", shopName: "y", totalCents: 100 } }), request({ id: "c" })],
    cases: [refund()],
  }));
  assert.deepEqual(kinds(items), ["working", "payment", "paused", "ideas", "approval", "refund", "ready"]);
});

test("the tab badge counts decisions, not a shopper at work or a request that is merely ready", () => {
  const items = needsYou(input({ working: { step: "", seconds: 1 }, paused: true, requests: [request({ id: "a", ideas: 2 }), request({ id: "c" })], cases: [refund()] }));
  assert.deepEqual(kinds(items), ["working", "paused", "ideas", "refund", "ready"]);
  assert.equal(badgeCount(items), 3);
  assert.equal(badgeCount(needsYou(input({ working: { step: "", seconds: 1 } }))), 0);
  assert.equal(badgeCount([]), 0);
});

test("nothing points at the page the owner is already on", () => {
  const items = needsYou(input({ working: { step: "", seconds: 2 }, requests: [request({ id: "g1", ideas: 2 }), request({ id: "a1", approval: { itemName: "x", shopName: "y", totalCents: 100 } }), request({ id: "z" })], cases: [refund()] }));
  const on = (route: string) => visibleNeeds(items, route).map((i) => i.id);
  assert.deepEqual(on("#/approve/g1"), ["working", "approval:a1", "refund:c1", "ready:z"], "the ideas page does not announce its own ideas");
  assert.deepEqual(on("#/orders"), ["working", "ideas:g1", "approval:a1", "ready:z"], "Orders does not announce its own refunds");
  assert.deepEqual(on("#/"), ["working", "ideas:g1", "approval:a1", "refund:c1"], "Home does not say 'go to my requests'");
  const town = visibleNeeds(items, "#/town");
  assert.equal(town.length, items.length, "the Town still shows everything");
  assert.equal(town[0]!.kind, "working");
  assert.equal(town[0]!.action, null, "but a shopper at work has no 'watch it live' button on the Town itself");
  assert.deepEqual(visibleNeeds(items, "").map((i) => i.id), on("#/"), "an empty route means Home");
  assert.deepEqual(needsYou(input({ paused: true })).length, visibleNeeds(needsYou(input({ paused: true })), "#/wallet").length, "a resume button has no page, so it is always shown");
});

test("the line saying what the shopper is doing is short, and never shows the guard's long private reasons", () => {
  assert.equal(shortStep({ type: "guard", shopId: "deal-zone", decision: "allow" }), "The guard allowed it");
  assert.equal(shortStep({ type: "guard", shopId: "x", decision: "ask", reason: "Gifts are a matter of taste, so nothing is bought until you pick one." }), "The guard wants your OK");
  assert.equal(shortStep({ type: "guard", shopId: "x", decision: "deny", reason: "Score 0 is below your minimum of 70." }), "The guard turned one down");
  assert.equal(shortStep({ type: "visit", shopId: "northgear", page: "product", label: "Wireless earbuds" }), "Reading Wireless earbuds at Northgear");
  assert.equal(shortStep({ type: "seller", shopId: "deal-zone", score: 0, ok: false, hiddenText: true }), "Deal-Zone scores 0 out of 100. Hidden text aimed at AI found");
  const long = shortStep({ type: "start", item: "A very long thing that someone typed into a request, going on and on and on and on and on" });
  assert.ok(long.length <= 70 && long.endsWith("…"), long);
  assert.equal(shortStep({ type: "pay", step: "done", shopId: "northgear" }), "Paid. Northgear has the order");
  for (const e of [{ type: "giveup" }, { type: "end", result: "bought" }, { type: "propose", shopId: "northgear", item: "Daypack", totalCents: 6800 }] as const) {
    const line = shortStep(e);
    assert.ok(line.length > 5 && line.length <= 70 && !/undefined/.test(line), JSON.stringify(e));
  }
});

