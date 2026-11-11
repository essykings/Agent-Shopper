// What an agent run reports while it happens. The Playground and the public Town square draw
// these. They carry only what is safe to show: shop names, catalog product names, scores and
// amounts. The words a person typed into a request are only in the private "start" event.

export type PageKind = "home" | "product" | "search" | "about" | "other";

export type WorldEvent =
  | { type: "start"; item?: string }
  | { type: "visit"; shopId: string; page: PageKind; label: string }
  | { type: "seller"; shopId: string; score: number; ok: boolean; hiddenText: boolean }
  | { type: "propose"; shopId: string; item: string; totalCents: number }
  | { type: "guard"; shopId: string; decision: "allow" | "ask" | "deny"; reason?: string }
  | { type: "giveup"; reason?: string }
  | { type: "pay"; step: "start" | "done" | "failed"; shopId?: string; totalCents?: number }
  | { type: "end"; result: "bought" | "asked" | "nothing" | "stopped" };

export type Emit = (event: WorldEvent) => void;

/** One event as it travels to a screen. */
export interface Feed {
  runId: string;
  /** A short anonymous name such as "Agent 4F2". */
  agent: string;
  at: number;
  /** True when this is an earlier run played again, not something happening now. */
  replay?: boolean;
  /** True when no real run exists yet and this is a scripted example. */
  sample?: boolean;
  /** True when the person looking at this screen started this run. Only ever set for them. */
  mine?: boolean;
  event: WorldEvent;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The public version of an event: no typed request text, no reasons that could quote a person's words. */
export function toPublic(e: WorldEvent): WorldEvent {
  switch (e.type) {
    case "start": return { type: "start" };
    // Search words and other labels the agent chose can echo what a person typed, so only a product's own name is kept.
    case "visit": return { ...e, label: e.page === "product" ? clip(e.label, 60) : "" };
    case "propose": return { ...e, item: clip(e.item, 60) };
    case "guard": return { type: "guard", shopId: e.shopId, decision: e.decision };
    case "giveup": return { type: "giveup" };
    default: return e;
  }
}
