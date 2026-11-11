// The logic behind the Playground and the Town square: where each agent stands, what its speech
// bubble says, and the pacing. No screen code here, so it can be tested without a browser.
// Events can arrive in a burst (a replay, or a fast run), so the Player releases them one at a
// time, a moment apart, so a person can follow what happens.

import type { Feed, WorldEvent } from "./events.ts";

export const SHOP_NAMES: Record<string, string> = { northgear: "Northgear", "deal-zone": "Deal-Zone", trailhead: "Trailhead" };
export const shopName = (id: string): string => SHOP_NAMES[id] ?? id;
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export type Tone = "plain" | "ok" | "warn" | "bad";
export type Place = { kind: "home" } | { kind: "shop"; id: string } | { kind: "gate" } | { kind: "bank" };

export interface AgentView {
  runId: string;
  name: string;
  place: Place;
  bubble: string;
  tone: Tone;
  replay: boolean;
  sample: boolean;
  /** This agent belongs to the person looking at the screen. */
  mine: boolean;
  /** Set when the run has ended: the agent is taken off the map a few seconds later. */
  doneAt: number | null;
}
export interface Flash {
  text: string;
  tone: Tone;
  until: number;
}
export interface LogLine {
  id: number;
  at: number;
  agent: string;
  text: string;
  tone: Tone;
  replay: boolean;
  mine: boolean;
}
export interface World {
  agents: Record<string, AgentView>;
  /** Short-lived badges: a seller's score over its shop, the guard's light, a coin from the bank to a shop. */
  shopFlash: Record<string, Flash>;
  gateFlash: Flash | null;
  coin: { shopId: string; until: number } | null;
  log: LogLine[];
}

export const emptyWorld = (): World => ({ agents: {}, shopFlash: {}, gateFlash: null, coin: null, log: [] });

export const FLASH_MS = 4000;
export const LEAVE_MS = 6000;
const MAX_LOG = 80;

export function describe(e: WorldEvent): { text: string; tone: Tone } {
  switch (e.type) {
    case "start": return { text: e.item ? `Started on: ${e.item}` : "Started a shopping trip", tone: "plain" };
    case "visit": {
      const s = shopName(e.shopId);
      if (e.page === "home") return { text: `Looking around ${s}`, tone: "plain" };
      if (e.page === "search") return { text: e.label ? `Searching ${s} for "${e.label}"` : `Searching ${s}`, tone: "plain" };
      if (e.page === "product") return { text: `Reading ${e.label} at ${s}`, tone: "plain" };
      if (e.page === "about") return { text: `Reading ${s}'s reviews and details`, tone: "plain" };
      return { text: `Opened a page at ${s}`, tone: "plain" };
    }
    case "seller":
      return { text: `${shopName(e.shopId)} scores ${e.score} out of 100${e.hiddenText ? ". Hidden text aimed at AI found" : ""}`, tone: e.ok ? "ok" : "bad" };
    case "propose": return { text: `Proposing ${e.item} from ${shopName(e.shopId)} for ${money(e.totalCents)}`, tone: "plain" };
    case "guard": {
      const why = e.reason ? `: ${e.reason}` : "";
      if (e.decision === "allow") return { text: "The guard allowed it", tone: "ok" };
      if (e.decision === "ask") return { text: `The guard wants the owner's OK${why}`, tone: "warn" };
      return { text: `The guard turned it down${why}`, tone: "bad" };
    }
    case "giveup": return { text: `Nothing fits the rules${e.reason ? `: ${e.reason}` : ""}`, tone: "warn" };
    case "pay":
      if (e.step === "start") return { text: `Paying ${e.shopId ? shopName(e.shopId) : "the shop"}${e.totalCents ? ` ${money(e.totalCents)}` : ""} through PayPal`, tone: "plain" };
      if (e.step === "done") return { text: `Paid. ${e.shopId ? shopName(e.shopId) : "The shop"} has the order`, tone: "ok" };
      return { text: "The payment did not go through. Nothing was charged", tone: "bad" };
    case "end": {
      if (e.result === "bought") return { text: "Finished: bought", tone: "ok" };
      if (e.result === "asked") return { text: "Finished: waiting for the owner's OK", tone: "warn" };
      if (e.result === "nothing") return { text: "Finished: nothing bought", tone: "warn" };
      return { text: "Stopped: nothing bought", tone: "warn" };
    }
  }
}

/** How long an event stays on screen before the same agent's next one is shown. */
export function stepDelay(e: WorldEvent): number {
  switch (e.type) {
    case "visit": return 1500;
    case "seller": return 1500;
    case "propose": return 1300;
    case "guard": return 1900;
    case "pay": return e.step === "start" ? 1600 : 2200;
    case "start": return 1100;
    default: return 1200;
  }
}

function placeFor(e: WorldEvent, current: Place): Place {
  switch (e.type) {
    case "start": case "giveup": return { kind: "home" };
    case "visit": case "seller": return { kind: "shop", id: e.shopId };
    case "propose": case "guard": return { kind: "gate" };
    case "pay": return { kind: "bank" };
    default: return current;
  }
}

/** Shows one event: moves the agent, updates its bubble, lights the badges, adds a line to the log. */
export function applyFeed(w: World, f: Feed, now: number): World {
  const e = f.event;
  const d = describe(e);
  const prev = w.agents[f.runId];
  const agent: AgentView = {
    runId: f.runId,
    name: f.agent,
    place: placeFor(e, prev?.place ?? { kind: "home" }),
    bubble: d.text,
    tone: d.tone,
    replay: !!f.replay,
    sample: !!f.sample,
    mine: !!f.mine,
    doneAt: e.type === "end" ? now : null,
  };
  const next: World = {
    ...w,
    agents: { ...w.agents, [f.runId]: agent },
    log: [...w.log, { id: (w.log.at(-1)?.id ?? 0) + 1, at: now, agent: f.agent, text: d.text, tone: d.tone, replay: !!f.replay, mine: !!f.mine }].slice(-MAX_LOG),
  };
  if (e.type === "seller") {
    next.shopFlash = { ...w.shopFlash, [e.shopId]: { text: `${e.score}/100${e.hiddenText ? " · hidden text" : ""}`, tone: e.ok ? "ok" : "bad", until: now + FLASH_MS } };
  }
  if (e.type === "guard") {
    next.gateFlash = { text: e.decision === "allow" ? "Allowed" : e.decision === "ask" ? "Ask owner" : "Turned down", tone: d.tone, until: now + FLASH_MS };
  }
  if (e.type === "pay" && e.step === "done" && e.shopId) {
    next.coin = { shopId: e.shopId, until: now + FLASH_MS };
    next.shopFlash = { ...next.shopFlash, [e.shopId]: { text: "Order received", tone: "ok", until: now + FLASH_MS } };
  }
  return next;
}

/** Drops badges that have timed out and agents that finished a while ago. Returns the same object when nothing changed. */
export function expire(w: World, now: number): World {
  let changed = false;
  const agents: Record<string, AgentView> = {};
  for (const [id, a] of Object.entries(w.agents)) {
    if (a.doneAt !== null && now - a.doneAt > LEAVE_MS) changed = true;
    else agents[id] = a;
  }
  const shopFlash: Record<string, Flash> = {};
  for (const [id, fl] of Object.entries(w.shopFlash)) {
    if (fl.until <= now) changed = true;
    else shopFlash[id] = fl;
  }
  const gateFlash = w.gateFlash && w.gateFlash.until <= now ? null : w.gateFlash;
  const coin = w.coin && w.coin.until <= now ? null : w.coin;
  if (gateFlash !== w.gateFlash || coin !== w.coin) changed = true;
  return changed ? { ...w, agents, shopFlash, gateFlash, coin } : w;
}

interface RunQueue {
  feeds: Feed[];
  nextAt: number;
  replay: boolean;
  ended: boolean;
}

/** Releases queued events a moment apart. Live runs play side by side. Earlier runs ("replays") play one at a time, and give way the moment a live run begins. */
export class Player {
  world: World = emptyWorld();
  private runs = new Map<string, RunQueue>();
  private replaying: string | null = null;

  enqueue(f: Feed, now: number): void {
    if (!f.replay) this.dropReplays();
    let q = this.runs.get(f.runId);
    if (!q) {
      q = { feeds: [], nextAt: now, replay: !!f.replay, ended: false };
      this.runs.set(f.runId, q);
    }
    if (q.feeds.length < 120) q.feeds.push(f);
  }

  private dropReplays(): void {
    let changed = false;
    for (const [id, q] of this.runs) {
      if (!q.replay) continue;
      this.runs.delete(id);
      changed = true;
    }
    if (changed || this.replaying) {
      const agents: Record<string, AgentView> = {};
      for (const [id, a] of Object.entries(this.world.agents)) if (!a.replay) agents[id] = a;
      this.world = { ...this.world, agents, log: this.world.log.filter((l) => !l.replay) };
      this.replaying = null;
    }
  }

  /** True while events are still waiting to be shown. */
  pending(): boolean {
    for (const q of this.runs.values()) if (q.feeds.length) return true;
    return false;
  }

  /** Call often (every 150 ms or so). Returns true when the picture changed. */
  tick(now: number): boolean {
    const before = this.world;
    for (const [id, q] of this.runs) {
      if (q.replay) {
        if (this.replaying === null) this.replaying = id;
        if (this.replaying !== id) continue;
      }
      if (now >= q.nextAt && q.feeds.length) {
        const f = q.feeds.shift()!;
        this.world = applyFeed(this.world, f, now);
        q.nextAt = now + stepDelay(f.event);
        if (f.event.type === "end") q.ended = true;
      }
      if (q.feeds.length === 0 && q.ended) {
        if (q.replay && now >= q.nextAt) this.replaying = null;
        // A finished live run needs no more bookkeeping once its last event was shown.
        if (!q.replay) this.runs.delete(id);
        else if (this.replaying === null) this.runs.delete(id);
      }
    }
    this.world = expire(this.world, now);
    return this.world !== before;
  }
}
