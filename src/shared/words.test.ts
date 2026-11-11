import { test } from "node:test";
import assert from "node:assert/strict";
import { keywords, searchLadder } from "./words.ts";

test("keywords drops small filler words and a trailing s, and keeps the rest in order", () => {
  assert.deepEqual(keywords("Water bottle for hiking"), ["water", "bottle", "hiking"]);
  assert.deepEqual(keywords("a pair of the Trail socks, please"), ["pair", "trail", "sock"]);
  assert.deepEqual(keywords("   "), []);
  assert.deepEqual(keywords("USB-C hub"), ["usb", "hub"], "one-letter pieces are dropped");
});

test("the retry ladder goes from what was asked to fewer and fewer key words, with no repeats", () => {
  assert.deepEqual(searchLadder("Water bottle for hiking"), ["water bottle for hiking", "water bottle hiking", "water bottle", "water"]);
  assert.deepEqual(searchLadder("Wireless earbuds"), ["wireless earbuds", "wireless"]);
  assert.deepEqual(searchLadder("socks"), ["socks"]);
  assert.deepEqual(searchLadder("  The   PS5 disc edition "), ["the ps5 disc edition", "ps5 disc edition", "ps5 disc", "ps5"]);
  assert.ok(searchLadder("one two three four five six seven").length <= 5, "never an endless list");
  assert.deepEqual(searchLadder(""), []);
});
