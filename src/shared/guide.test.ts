import { test } from "node:test";
import assert from "node:assert/strict";
import { guideSteps } from "./guide.ts";
import type { GuideInput } from "./guide.ts";

const none: GuideInput = { requests: [], visited: { town: false, playground: false, orders: false }, hasCase: false };
const flags = (g: ReturnType<typeof guideSteps>) => g.steps.map((s) => s.done);

test("a new owner starts at step one, with five steps in a fixed order", () => {
  const g = guideSteps(none);
  assert.deepEqual(g.steps.map((s) => s.id), ["request", "run", "watch", "decide", "orders"]);
  assert.deepEqual([g.doneCount, g.current], [0, 0]);
  assert.deepEqual(g.steps[0]!.action, { label: "New request", run: "new" });
});

test("each step ticks from what really happened", () => {
  assert.deepEqual(flags(guideSteps({ ...none, requests: [{ ran: false, hasOrder: false }] })), [true, false, false, false, false]);
  assert.deepEqual(flags(guideSteps({ ...none, requests: [{ ran: true, hasOrder: false }] })), [true, true, false, false, false]);
  assert.deepEqual(flags(guideSteps({ ...none, visited: { ...none.visited, town: true } })), [false, false, true, false, false], "watching the Town counts even before a request");
  assert.deepEqual(flags(guideSteps({ ...none, visited: { ...none.visited, playground: true } })), [false, false, true, false, false], "so does the Playground");
  assert.deepEqual(flags(guideSteps({ ...none, requests: [{ ran: true, hasOrder: true }] })), [true, true, false, true, false]);
  assert.deepEqual(flags(guideSteps({ ...none, visited: { ...none.visited, orders: true } })), [false, false, false, false, true]);
  assert.deepEqual(flags(guideSteps({ ...none, hasCase: true })), [false, false, false, false, true], "a refund case proves they found Orders");
});

test("the current step is the first one not done, and it moves on past a step done out of order", () => {
  const g = guideSteps({ ...none, requests: [{ ran: false, hasOrder: false }], visited: { ...none.visited, town: true } });
  assert.deepEqual([g.doneCount, g.current], [2, 1], "request and watch are done, so step two is next");
  const all = guideSteps({ requests: [{ ran: true, hasOrder: true }], visited: { town: true, playground: true, orders: true }, hasCase: true });
  assert.deepEqual([all.doneCount, all.current], [5, 5], "everything done");
});

test("any one request that was run counts, however many others were not", () => {
  const g = guideSteps({ ...none, requests: [{ ran: false, hasOrder: false }, { ran: false, hasOrder: false }, { ran: true, hasOrder: false }] });
  assert.equal(g.steps[1]!.done, true);
});

test("every step explains itself in plain words and offers one action", () => {
  for (const s of guideSteps(none).steps) {
    assert.ok(s.title.length > 5 && s.text.length > 30, s.id);
    assert.doesNotMatch(s.text + s.title, /undefined|null|API|JSON|webhook/i, s.id);
    assert.ok("href" in s.action || "run" in s.action, s.id);
  }
});
