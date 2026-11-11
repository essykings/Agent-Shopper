// Carries live agent events from the runs to the screens, in memory.
//   private: each person sees their own runs, in full
//   public:  everyone sees every run as an anonymous agent, with nothing a person typed
// One app instance is enough for the demo. With several instances this would need a shared channel.

import { createHash, randomUUID } from "node:crypto";
import { toPublic } from "../shared/events.ts";
import type { Emit, Feed } from "../shared/events.ts";

type Listener = (f: Feed) => void;

/** A run that never reported its end (a crash, a restart) stops counting as "shopping now" after this long. */
const ACTIVE_FOR_MS = 5 * 60_000;
/** How long finished runs are remembered, so the "finished today" count survives a day boundary. */
const KEEP_FINISHED_MS = 48 * 3_600_000;
const MAX_FINISHED = 5000;

/** A short, stable, anonymous name for a run. It reveals nothing about who ran it. */
export const agentName = (runId: string): string => `Agent ${createHash("sha256").update(runId).digest("hex").slice(0, 3).toUpperCase()}`;

export class Hub {
  private priv = new Map<string, Set<Listener>>();
  /** Public viewers. If the viewer is signed in, their id is kept so their own runs can be marked for them alone. */
  private pub = new Map<Listener, string | null>();
  /** Runs that have ended: who ran them and when. Only counted, never shown. Kept in memory, so a restart starts the count again. */
  private finished: Array<{ owner: string; at: number }> = [];
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
      else if (event.type === "end") {
        if (this.active.delete(runId)) this.noteFinished(userId, at);
      }
      for (const l of this.priv.get(userId) ?? []) l({ runId, agent, at, mine: true, event });
      const safe: Feed = { runId, agent, at, event: toPublic(event) };
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

  private noteFinished(owner: string, at: number): void {
    this.finished.push({ owner, at });
    const keepFrom = at - KEEP_FINISHED_MS;
    while (this.finished.length > MAX_FINISHED || (this.finished[0] && this.finished[0].at < keepFrom)) this.finished.shift();
  }

  /** How many runs have finished since midnight (UTC), in total or for one person. Only a number. */
  finishedToday(owner?: string, now: number = Date.now()): number {
    const midnight = now - (now % 86_400_000);
    return this.finished.filter((f) => f.at >= midnight && (owner === undefined || f.owner === owner)).length;
  }
}
