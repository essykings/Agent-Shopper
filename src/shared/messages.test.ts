import { test } from "node:test";
import assert from "node:assert/strict";
import { giveUpBody } from "./messages.ts";

const laptop = { itemName: "Laptop, 14 inch", shopId: "northgear", totalCents: 62100 };
const OVER = "The cheapest option from a shop you can trust is Laptop, 14 inch at Northgear for $621.00.";

test("the reason is said as the shopper wrote it, and the closest option is added only when the reason does not already give its price", () => {
  assert.equal(giveUpBody({ reason: "Nothing fits." }), "Nothing fits.");
  assert.equal(giveUpBody({ reason: "Nothing fits.", closest: laptop }), `Nothing fits. ${OVER}`);
  assert.equal(giveUpBody({ reason: "The only laptop is a 14-inch at Northgear for $621.00, far over the limit.", closest: laptop }), "The only laptop is a 14-inch at Northgear for $621.00, far over the limit.", "its price is already in the reason");
  assert.equal(giveUpBody({ closest: laptop }), OVER, "with no reason, the closest option stands alone");
  assert.equal(giveUpBody({}), "");
  assert.equal(giveUpBody({ reason: "x", closest: null }), "x");
});
