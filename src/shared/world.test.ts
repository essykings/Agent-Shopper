import { test } from "node:test";
import assert from "node:assert/strict";
import type { Feed, WorldEvent } from "./events.ts";
import { LEAVE_MS, Player, applyFeed, bubbleText, describe, emptyWorld, expire } from "./world.ts";

const feed = (runId: string, event: WorldEvent, extra: Partial<Feed> = {}): Feed => ({ runId, agent: `Agent ${runId.toUpperCase()}`, at: 0, event, ...extra });

test("every kind of event has plain words, and a private reason shows only when it was sent", () => {
  const events: WorldEvent[] = [
    { type: "start" }, { type: "start", item: "earbuds" },
    { type: "visit", shopId: "northgear", page: "home", label: "Home page" }, { type: "visit", shopId: "northgear", page: "search", label: "earbuds" }, { type: "visit", shopId: "northgear", page: "search", label: "" },
    { type: "visit", shopId: "trailhead", page: "product", label: "Daypack" }, { type: "visit", shopId: "deal-zone", page: "about", label: "x" }, { type: "visit", shopId: "deal-zone", page: "other", label: "x" },
    { type: "seller", shopId: "deal-zone", score: 0, ok: false, hiddenText: true }, { type: "seller", shopId: "northgear", score: 92, ok: true, hiddenText: false },
    { type: "propose", shopId: "northgear", item: "Wireless earbuds", totalCents: 4500 },
    { type: "guard", shopId: "x", decision: "allow" }, { type: "guard", shopId: "x", decision: "ask" }, { type: "guard", shopId: "x", decision: "deny", reason: "Score 0 is low" },
    { type: "giveup" }, { type: "giveup", reason: "too dear" },
    { type: "pay", step: "start", shopId: "northgear", totalCents: 4500 }, { type: "pay", step: "done", shopId: "northgear" }, { type: "pay", step: "failed" },
    { type: "end", result: "bought" }, { type: "end", result: "asked" }, { type: "end", result: "nothing" }, { type: "end", result: "stopped" },
  ];
  for (const e of events) {
    const d = describe(e);
    assert.ok(d.text.length > 5 && !/undefined|null|\[object/.test(d.text), JSON.stringify(e));
  }
  assert.match(describe({ type: "guard", shopId: "x", decision: "deny", reason: "Score 0 is low" }).text, /Score 0 is low/);
  assert.doesNotMatch(describe({ type: "guard", shopId: "x", decision: "deny" }).text, /:/);
  assert.equal(describe({ type: "propose", shopId: "northgear", item: "Wireless earbuds", totalCents: 4500 }).text, "Proposing Wireless earbuds from Northgear for $45.00");
});

test("a speech bubble is only a few words: no shop name, and a payment is just the amount", () => {
  assert.equal(bubbleText({ type: "pay", step: "start", shopId: "trailhead", totalCents: 3800 }), "$38.00");
  assert.equal(bubbleText({ type: "start", item: "USB-C hub" }), "Wants: USB-C hub");
  assert.equal(bubbleText({ type: "visit", shopId: "northgear", page: "product", label: "Webcam, 1080p" }), "Webcam, 1080p");
  assert.equal(bubbleText({ type: "seller", shopId: "deal-zone", score: 0, ok: false, hiddenText: true }), "Hidden text found");
  assert.equal(bubbleText({ type: "guard", shopId: "x", decision: "deny", reason: "private reason" }), "Turned down");
  const w = applyFeed(emptyWorld(), feed("a", { type: "pay", step: "start", shopId: "trailhead", totalCents: 1800 }), 0);
  assert.equal(w.agents["a"]!.bubble, "$18.00");
  assert.match(w.log[0]!.text, /Paying Trailhead \$18\.00 through PayPal/, "the step list keeps the full sentence");
});

test("an agent walks to where each step happens, and the badges light up", () => {
  let w = emptyWorld();
  const step = (e: WorldEvent, at: number) => (w = applyFeed(w, feed("a1", e), at));
  step({ type: "start" }, 0);
  assert.deepEqual(w.agents["a1"]!.place, { kind: "home" });
  step({ type: "visit", shopId: "deal-zone", page: "product", label: "Wireless earbuds" }, 10);
  assert.deepEqual(w.agents["a1"]!.place, { kind: "shop", id: "deal-zone" });
  step({ type: "seller", shopId: "deal-zone", score: 0, ok: false, hiddenText: true }, 20);
  assert.equal(w.shopFlash["deal-zone"]!.tone, "bad");
  assert.match(w.shopFlash["deal-zone"]!.text, /hidden text/);
  step({ type: "guard", shopId: "deal-zone", decision: "deny" }, 30);
  assert.deepEqual(w.agents["a1"]!.place, { kind: "gate" });
  assert.deepEqual({ text: w.gateFlash!.text, tone: w.gateFlash!.tone }, { text: "Turned down", tone: "bad" });
  step({ type: "pay", step: "start", shopId: "northgear", totalCents: 4500 }, 40);
  assert.deepEqual(w.agents["a1"]!.place, { kind: "bank" });
  assert.equal(w.coin, null, "no coin until the payment is done");
  step({ type: "pay", step: "done", shopId: "northgear", totalCents: 4500 }, 50);
  assert.equal(w.coin!.shopId, "northgear");
  assert.equal(w.shopFlash["northgear"]!.text, "Order received");
  assert.equal(w.log.length, 6);
  assert.deepEqual(w.log.map((l) => l.id), [1, 2, 3, 4, 5, 6]);
});

test("badges time out, and a finished agent leaves after a few seconds", () => {
  let w = emptyWorld();
  w = applyFeed(w, feed("a1", { type: "seller", shopId: "northgear", score: 90, ok: true, hiddenText: false }), 0);
  w = applyFeed(w, feed("a1", { type: "end", result: "nothing" }), 0);
  assert.equal(expire(w, 1000), w, "nothing changed, the same object comes back");
  assert.equal(expire(w, 5000).shopFlash["northgear"], undefined);
  assert.ok(expire(w, 5000).agents["a1"], "still there");
  assert.equal(expire(w, LEAVE_MS + 1).agents["a1"], undefined);
});

test("events that arrive together are shown one at a time, a moment apart", () => {
  const p = new Player();
  const evs: WorldEvent[] = [{ type: "start" }, { type: "visit", shopId: "northgear", page: "home", label: "Home page" }, { type: "end", result: "nothing" }];
  for (const e of evs) p.enqueue(feed("a1", e), 0);
  assert.equal(p.pending(), true);
  assert.equal(p.tick(0), true);
  assert.equal(p.world.log.length, 1);
  assert.equal(p.tick(500), false, "too soon");
  assert.equal(p.world.log.length, 1);
  p.tick(1200);
  assert.equal(p.world.log.length, 2);
  p.tick(1200 + 1500);
  assert.equal(p.world.log.length, 3);
  assert.ok(p.world.agents["a1"]!.doneAt !== null);
  assert.equal(p.pending(), false, "everything has been shown");
});

test("two live runs play side by side, each at its own pace", () => {
  const p = new Player();
  p.enqueue(feed("a1", { type: "start" }), 0);
  p.enqueue(feed("b2", { type: "start" }), 0);
  p.tick(0);
  assert.deepEqual(Object.keys(p.world.agents).sort(), ["a1", "b2"]);
});

test("earlier runs play one after another, and give way when a live run begins", () => {
  const p = new Player();
  const run = (id: string, at: number) => {
    p.enqueue(feed(id, { type: "start" }, { replay: true }), at);
    p.enqueue(feed(id, { type: "end", result: "nothing" }, { replay: true }), at);
  };
  run("r1", 0); run("r2", 0);
  p.tick(0);
  assert.deepEqual(Object.keys(p.world.agents), ["r1"], "only the first replay plays");
  p.tick(1200);
  assert.equal(p.world.agents["r1"]!.doneAt, 1200);
  assert.equal(p.world.agents["r2"], undefined, "the second waits for the first");
  p.tick(2500);
  p.tick(2500);
  assert.ok(p.world.agents["r2"], "now the second plays");
  p.enqueue(feed("live1", { type: "start" }), 3000);
  assert.equal(p.world.log.some((l) => l.replay), false, "replays are cleared when something real happens");
  p.tick(3000);
  assert.deepEqual(Object.keys(p.world.agents), ["live1"]);
  assert.equal(p.world.agents["live1"]!.replay, false);
});

test("a flood of events for one run cannot grow without bound", () => {
  const p = new Player();
  for (let i = 0; i < 1000; i++) p.enqueue(feed("a1", { type: "start" }), 0);
  let shown = 0;
  for (let t = 0; t < 400_000; t += 100) if (p.tick(t)) shown++;
  assert.ok(p.world.log.length <= 80);
  assert.ok(shown <= 125, `only the first ~120 are queued, saw ${shown} changes`);
});

test("an agent that belongs to the viewer is marked, and others are not", () => {
  let w = emptyWorld();
  w = applyFeed(w, feed("a1", { type: "start" }, { mine: true }), 0);
  w = applyFeed(w, feed("b2", { type: "start" }), 0);
  assert.equal(w.agents["a1"]!.mine, true);
  assert.equal(w.agents["b2"]!.mine, false);
  assert.deepEqual(w.log.map((l) => l.mine), [true, false]);
});
