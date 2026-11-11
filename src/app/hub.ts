// Carries live agent events from the runs to the screens, in memory.
//   private: each person sees their own runs, in full
//   public:  everyone sees every run as an anonymous agent, with nothing a person typed
// One app instance is enough for the demo. With several instances this would need a shared channel.

import { createHash, randomUUID } from "node:crypto";
import { toPublic } from "../shared/events.ts";
import type { Emit, Feed, WorldEvent } from "../shared/events.ts";

type Listener = (f: Feed) => void;

const KEEP_RUNS = 20;
/** A run that never reported its end (a crash, a restart) stops counting as "shopping now" after this long. */
const ACTIVE_FOR_MS = 5 * 60_000;
const KEEP_EVENTS_PER_RUN = 80;

/** A scripted example, shown only until a real run exists. It is always marked as an example. */
const SAMPLE: WorldEvent[] = [
  { type: "start" },
  { type: "visit", shopId: "deal-zone", page: "search", label: "" },
  { type: "visit", shopId: "northgear", page: "search", label: "" },
  { type: "visit", shopId: "deal-zone", page: "product", label: "Wireless earbuds" },
  { type: "seller", shopId: "deal-zone", score: 0, ok: false, hiddenText: true },
  { type: "propose", shopId: "deal-zone", item: "Wireless earbuds", totalCents: 2900 },
  { type: "guard", shopId: "deal-zone", decision: "deny" },
  { type: "visit", shopId: "northgear", page: "product", label: "Wireless earbuds" },
  { type: "seller", shopId: "northgear", score: 92, ok: true, hiddenText: false },
  { type: "propose", shopId: "northgear", item: "Wireless earbuds", totalCents: 4500 },
  { type: "guard", shopId: "northgear", decision: "allow" },
  { type: "pay", step: "start", shopId: "northgear", totalCents: 4500 },
  { type: "pay", step: "done", shopId: "northgear", totalCents: 4500 },
  { type: "end", result: "bought" },
];

/** A short, stable, anonymous name for a run. It reveals nothing about who ran it. */
export const agentName = (runId: string): string => `Agent ${createHash("sha256").update(runId).digest("hex").slice(0, 3).toUpperCase()}`;

export class Hub {
  private priv = new Map<string, Set<Listener>>();
  /** Public viewers. If the viewer is signed in, their id is kept so their own runs can be marked for them alone. */
  private pub = new Map<Listener, string | null>();
  private recent: Array<{ runId: string; owner: string; events: Feed[] }> = [];
  private perIp = new Map<string, number>();
  /** Runs that have started and not ended: run id to when it started. Only a count is ever shown. */
  private active = new Map<string, number>();

  /** The emitter one run uses. Events go to the owner in full and to everyone else without private text. */
  start(userId: string): { runId: string; emit: Emit } {
    const runId = randomUUID();
    const agent = agentName(runId);
    const emit: Emit = (event) => {
      const at = Date.now();
      if (event.type === "start") this.active.set(runId, at);
      else if (event.type === "end") this.active.delete(runId);
      for (const l of this.priv.get(userId) ?? []) l({ runId, agent, at, mine: true, event });
      const safe: Feed = { runId, agent, at, event: toPublic(event) };
      let run = this.recent.find((r) => r.runId === runId);
      if (!run) {
        run = { runId, owner: userId, events: [] };
        this.recent.push(run);
        if (this.recent.length > KEEP_RUNS) this.recent.shift();
      }
      if (run.events.length < KEEP_EVENTS_PER_RUN) run.events.push(safe);
      for (const [l, viewer] of this.pub) l(viewer === userId ? { ...safe, mine: true } : safe);
    };
    return { runId, emit };
  }

  onPrivate(userId: string, l: Listener): () => void {
    const set = this.priv.get(userId) ?? new Set<Listener>();
    set.add(l);
    this.priv.set(userId, set);
    return () => {
      set.delete(l);
      if (!set.size) this.priv.delete(userId);
    };
  }

  /** Returns null when there are too many viewers, from this address or in total. */
  onPublic(ip: string, l: Listener, limits: { perIp: number; total: number }, viewer: string | null = null): (() => void) | null {
    if (this.pub.size >= limits.total || (this.perIp.get(ip) ?? 0) >= limits.perIp) return null;
    this.pub.set(l, viewer);
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);
    return () => {
      this.pub.delete(l);
      const n = (this.perIp.get(ip) ?? 1) - 1;
      if (n <= 0) this.perIp.delete(ip);
      else this.perIp.set(ip, n);
    };
  }

  viewers(): number {
    return this.pub.size;
  }

  /** How many shoppers are working right now, for the "live" dot. Only a number: nothing about who. */
  activeRuns(now: number = Date.now()): number {
    for (const [id, startedAt] of this.active) if (now - startedAt >= ACTIVE_FOR_MS) this.active.delete(id);
    return this.active.size;
  }

  /** Earlier runs to play again when someone opens the Town square: real ones, or the example if there are none. */
  replay(viewer: string | null = null): Feed[] {
    if (this.recent.length === 0) {
      return SAMPLE.map((event, i) => ({ runId: "sample", agent: "Agent 000", at: i, sample: true, replay: true, event }));
    }
    // The five newest runs, except that the viewer's own latest run always comes first, so it is the one they see replayed.
    let runs = this.recent.slice(-5);
    const mine = viewer === null ? undefined : [...this.recent].reverse().find((r) => r.owner === viewer);
    if (mine) runs = [mine, ...runs.filter((r) => r !== mine).slice(-4)];
    return runs.flatMap((r) => r.events.map((f) => ({ ...f, replay: true, ...(viewer !== null && r.owner === viewer ? { mine: true } : {}) })));
  }
}
