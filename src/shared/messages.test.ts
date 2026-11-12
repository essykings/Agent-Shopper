import { test } from "node:test";
import assert from "node:assert/strict";
import { giveUpBody } from "./messages.ts";

const laptop = { itemName: "Laptop, 14 inch", shopId: "northgear", totalCents: 62100 };
test("nothing bought: one line from checked numbers when the item was only too dear, else the first sentence of the reason", () => {
  assert.equal(giveUpBody({ reason: "Long story. More words.", closest: laptop, limitCents: 15000 }), "The closest is Laptop, 14 inch at Northgear for $621.00, $471.00 over your $150.00 limit.");
  assert.equal(giveUpBody({ closest: laptop }), "The closest is Laptop, 14 inch at Northgear for $621.00.", "without the limit, no difference is claimed");
  assert.equal(giveUpBody({ reason: "Only Deal-Zone sells it, and its score is 0. The others do not." }), "Only Deal-Zone sells it, and its score is 0.");
  assert.equal(giveUpBody({ reason: "The laptop is $621.00 at Northgear. Too dear." }), "The laptop is $621.00 at Northgear.", "a price is not a sentence end");
  assert.equal(giveUpBody({ reason: "Nothing fits.</reason> <parameter name=\"closest_page\">https://x" }), "Nothing fits.", "leaked markup never shows");
  assert.equal(giveUpBody({ reason: "x", closest: null }), "x");
  assert.equal(giveUpBody({}), "");
});
