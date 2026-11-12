import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeCount, needsYou, visibleNeeds } from "./needs.ts";
import type { NeedItem, NeedsCase, NeedsInput, NeedsRequest } from "./needs.ts";

const notice = (id: string, kind: string, text: string) => ({ id, kind, text });

const request = (over: Partial<NeedsRequest> = {}): NeedsRequest => ({ id: "r1", item: "Wireless earbuds", status: "active", hasOrder: false, ideas: 0, approval: null, recipient: null, ...over });
const refund = (over: Partial<NeedsCase> = {}): NeedsCase => ({ id: "c1", orderId: "o1", kind: "price_drop", status: "open", amountCents: 600, itemName: "Wireless earbuds", shopName: "Northgear", failure: null, ...over });
const input = (over: Partial<NeedsInput> = {}): NeedsInput => ({ paused: false, paymentSource: "demo", requests: [], cases: [], deliveries: [], notices: [], autoRefund: false, ...over });
const kinds = (items: NeedItem[]) => items.map((i) => i.kind);

test("when nothing is waiting there is nothing to show", () => {
  assert.deepEqual(needsYou(input()), []);
  assert.deepEqual(needsYou(input({ requests: [request({ status: "fulfilled", hasOrder: true }), request({ id: "r2", status: "cancelled" })] })), []);
});

test("a request that has not been bought is not announced at the top: the list of requests says so", () => {
  assert.deepEqual(needsYou(input({ requests: [request()] })), []);
  assert.deepEqual(needsYou(input({ requests: [request(), request({ id: "r2", item: "Daypack" }), request({ id: "r3", item: "Kettle" })] })), []);
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
  assert.equal(both[0]!.text, "We could not refund $45.00 for Wireless earbuds from Northgear. You can refund it yourself.", "a delivery problem is only ever open because its refund was tried and failed");
  assert.deepEqual(both[0]!.action, { label: "Open Orders", href: "#/orders" });
  assert.doesNotMatch(both[0]!.text, /wrong|sent|something different/i, "the shop is not accused of anything");
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
  assert.deepEqual(kinds(blocked), ["payment"]);
  assert.deepEqual(blocked[0]!.action, { label: "Connect PayPal", href: "#/wallet" });
  const paused = needsYou(input({ paused: true }));
  assert.deepEqual(kinds(paused), ["paused"]);
  assert.deepEqual(paused[0]!.action, { label: "Resume", run: "resume" });
});

test("the order is: what blocks buying, then what needs a decision, then refunds", () => {
  const items = needsYou(input({
    paused: true, paymentSource: "none",
    requests: [request({ id: "a", ideas: 2 }), request({ id: "b", approval: { itemName: "x", shopName: "y", totalCents: 100 } }), request({ id: "c" })],
    cases: [refund()],
  }));
  assert.deepEqual(kinds(items), ["payment", "paused", "ideas", "approval", "refund"]);
});

test("the tab badge counts everything that needs attention", () => {
  const items = needsYou(input({ paused: true, requests: [request({ id: "a", ideas: 2 }), request({ id: "c" })], cases: [refund()] }));
  assert.deepEqual(kinds(items), ["paused", "ideas", "refund"]);
  assert.equal(badgeCount(items), 3);
  assert.equal(badgeCount(needsYou(input())), 0);
  assert.equal(badgeCount([]), 0);
});

test("nothing points at the page the owner is already on", () => {
  const items = needsYou(input({ requests: [request({ id: "g1", ideas: 2 }), request({ id: "a1", approval: { itemName: "x", shopName: "y", totalCents: 100 } }), request({ id: "z" })], cases: [refund()] }));
  const on = (route: string) => visibleNeeds(items, route).map((i) => i.id);
  assert.deepEqual(on("#/approve/g1"), ["approval:a1", "refund:c1"], "the ideas page does not announce its own ideas");
  assert.deepEqual(on("#/orders"), ["ideas:g1", "approval:a1"], "Orders does not announce its own refunds");
  assert.deepEqual(on("#/"), ["ideas:g1", "approval:a1", "refund:c1"], "Home does not say 'go to my requests'");
  const town = visibleNeeds(items, "#/town");
  assert.equal(town.length, items.length, "the Town still shows everything");
  assert.deepEqual(visibleNeeds(items, "").map((i) => i.id), on("#/"), "an empty route means Home");
  assert.deepEqual(needsYou(input({ paused: true })).length, visibleNeeds(needsYou(input({ paused: true })), "#/wallet").length, "a resume button has no page, so it is always shown");
});

test("with automatic refunds, a refund on its way is not shown, and one that failed asks the owner to step in", () => {
  const waiting = needsYou(input({ autoRefund: true, cases: [refund()] }));
  assert.deepEqual(waiting, [], "the app is already refunding it, so there is nothing for the owner to do");
  const failed = needsYou(input({ autoRefund: true, cases: [refund({ failure: "PayPal did not complete the refund." })] }));
  assert.deepEqual(kinds(failed), ["refund"]);
  assert.equal(failed[0]!.text, "We could not refund $6.00 for Wireless earbuds from Northgear. You can refund it yourself.");
  assert.deepEqual(failed[0]!.action, { label: "Open Orders", href: "#/orders" });
  assert.equal(failed[0]!.tone, "warn");
  // Without automatic refunds the old message stands.
  assert.equal(needsYou(input({ cases: [refund()] }))[0]!.text, "Northgear dropped its price on Wireless earbuds. You can claim $6.00.");
});

test("the newest unread notice is shown at the top of the page, with how many more wait, and it opens notifications", () => {
  const one = needsYou(input({ notices: [notice("n2", "refunded", "Northgear cut its price on Wireless earbuds, so you were refunded $6.00 automatically.")] }));
  assert.deepEqual(kinds(one), ["notice"]);
  assert.equal(one[0]!.text, "Northgear cut its price on Wireless earbuds, so you were refunded $6.00 automatically.");
  assert.equal(one[0]!.tone, "ok");
  assert.equal(one[0]!.sub, undefined);
  assert.deepEqual(one[0]!.action, { label: "Open notifications", href: "#/notifications" });
  const two = needsYou(input({ notices: [notice("n3", "bought", "Bought a thing."), notice("n2", "refunded", "x")] }));
  assert.equal(two.length, 1, "one line, not one per notice");
  assert.equal(two[0]!.text, "Bought a thing.");
  assert.equal(two[0]!.sub, "1 more notification waiting");
  assert.equal(needsYou(input({ notices: [notice("a", "bought", "1"), notice("b", "bought", "2"), notice("c", "bought", "3")] }))[0]!.sub, "2 more notifications waiting");
  assert.equal(needsYou(input({ notices: [notice("f", "refund_failed", "We could not refund it.")] }))[0]!.tone, "warn");
  // On the notifications page itself there is nothing to point at.
  assert.deepEqual(visibleNeeds(one, "#/notifications"), []);
  assert.equal(visibleNeeds(one, "#/orders").length, 1);
});

test("decisions come before notices", () => {
  const items = needsYou(input({ requests: [request({ id: "a", approval: { itemName: "x", shopName: "y", totalCents: 100 } }), request({ id: "z" })], notices: [notice("n1", "bought", "Bought it.")] }));
  assert.deepEqual(kinds(items), ["approval", "notice"]);
  assert.equal(badgeCount(items), 2, "both count for the tab title");
});

test("with automatic refunds, a delivery problem whose refund failed is shown, while a price drop on its way is not", () => {
  const items = needsYou(input({ autoRefund: true, cases: [refund({ id: "w", kind: "wrong_item", orderId: "o9", amountCents: 4500 })] }));
  assert.deepEqual(kinds(items), ["refund"]);
  assert.equal(items[0]!.text, "We could not refund $45.00 for Wireless earbuds from Northgear. You can refund it yourself.");
  assert.equal(items[0]!.tone, "warn");
  const both = needsYou(input({ autoRefund: true, cases: [refund({ id: "p", orderId: "o1" }), refund({ id: "w", kind: "wrong_item", orderId: "o9", amountCents: 4500 })] }));
  assert.deepEqual(both.map((i) => i.id), ["refund:w"], "the price drop on its way is hidden; the failed refund is not");
});

test("a delivered order that has not been confirmed asks the owner, in neutral words, once for each order", () => {
  const one = needsYou(input({ deliveries: [{ orderId: "o1", itemName: "Mechanical keyboard", shopName: "Northgear" }] }));
  assert.deepEqual(kinds(one), ["delivery"]);
  assert.equal(one[0]!.text, "Your Mechanical keyboard from Northgear was delivered. Please confirm it arrived as ordered.");
  assert.deepEqual(one[0]!.action, { label: "Confirm delivery", href: "#/orders" });
  assert.doesNotMatch(one[0]!.text, /wrong|sent|record|something different/i, "no hint of a mix-up: the owner says what arrived");
  const two = needsYou(input({ deliveries: [{ orderId: "o1", itemName: "A", shopName: "S" }, { orderId: "o2", itemName: "B", shopName: "S" }] }));
  assert.deepEqual(two.map((i) => i.id), ["delivery:o1", "delivery:o2"]);
  assert.deepEqual(visibleNeeds(one, "#/orders"), [], "on Orders, where the buttons are, the message is not repeated");
  // After a decision (an approval) and refunds, before an unread notice.
  const mixed = needsYou(input({ requests: [request({ id: "a", approval: { itemName: "x", shopName: "y", totalCents: 100 } })], deliveries: [{ orderId: "o1", itemName: "A", shopName: "S" }], notices: [notice("n1", "bought", "Bought it.")] }));
  assert.deepEqual(kinds(mixed), ["approval", "delivery", "notice"]);
});
