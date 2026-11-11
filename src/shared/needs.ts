// What is waiting for the owner right now, worked out from what the app already knows. No screen code
// here, so every state can be tested without a browser. The "Needs you" bar and the tab title use it.

import type { WorldEvent } from "./events.ts";
import { describe } from "./world.ts";

/** One short line about what the shopper is doing now. The guard's reasons are long, so only its verdict is shown. */
export function shortStep(e: WorldEvent): string {
  if (e.type === "guard") return e.decision === "allow" ? "The guard allowed it" : e.decision === "ask" ? "The guard wants your OK" : "The guard turned one down";
  const text = describe(e).text;
  return text.length > 70 ? `${text.slice(0, 69).trimEnd()}…` : text;
}

export type NeedKind = "working" | "payment" | "paused" | "ideas" | "approval" | "refund" | "ready";
export type NeedTone = "plain" | "ok" | "warn" | "bad";
export type NeedAction = { label: string; href: string } | { label: string; run: "resume" };

export interface NeedItem {
  id: string;
  kind: NeedKind;
  tone: NeedTone;
  text: string;
  /** A smaller second line. */
  sub?: string;
  action: NeedAction | null;
}

export interface NeedsRequest {
  id: string;
  item: string;
  status: string;
  hasOrder: boolean;
  /** Gift ideas waiting for a choice. */
  ideas: number;
  /** A purchase the guard wants the owner's OK for. */
  approval: { itemName: string; shopName: string; totalCents: number } | null;
  /** Who a gift is for. */
  recipient: string | null;
}

export interface NeedsCase {
  id: string;
  orderId: string;
  kind: string;
  status: string;
  amountCents: number;
  itemName: string;
  shopName: string;
}

export interface NeedsInput {
  paused: boolean;
  paymentSource: "demo" | "own" | "none";
  requests: NeedsRequest[];
  cases: NeedsCase[];
  /** Set while a shopper run is in progress: the latest step in words, and how long it has been going. */
  working: { step: string; seconds: number } | null;
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Most urgent first. */
export function needsYou(input: NeedsInput): NeedItem[] {
  const items: NeedItem[] = [];

  if (input.working) {
    items.push({
      id: "working",
      kind: "working",
      tone: "plain",
      text: "Your shopper is looking at the shops…",
      sub: `${input.working.step ? `${input.working.step} · ` : ""}${input.working.seconds}s`,
      action: { label: "Watch it live", href: "#/town" },
    });
  }

  const open = input.requests.filter((r) => r.status === "active" && !r.hasOrder);

  if (input.paymentSource === "none" && open.length > 0) {
    items.push({ id: "payment", kind: "payment", tone: "warn", text: "Connect a PayPal account so your shopper can buy.", action: { label: "Connect PayPal", href: "#/wallet" } });
  }
  if (input.paused) {
    items.push({ id: "paused", kind: "paused", tone: "warn", text: "Your shopper is paused. It will not run or buy until you resume it.", action: { label: "Resume", run: "resume" } });
  }

  for (const r of open) {
    if (r.ideas > 0) {
      items.push({
        id: `ideas:${r.id}`,
        kind: "ideas",
        tone: "warn",
        text: `Your shopper found ${plural(r.ideas, "gift idea", "gift ideas")}${r.recipient ? ` for ${r.recipient}` : ""}. Nothing is bought until you choose.`,
        action: { label: r.ideas === 1 ? "See the idea" : `See the ${r.ideas} ideas`, href: `#/approve/${r.id}` },
      });
    } else if (r.approval) {
      items.push({
        id: `approval:${r.id}`,
        kind: "approval",
        tone: "warn",
        text: `Your shopper wants to buy ${r.approval.itemName} for ${money(r.approval.totalCents)} from ${r.approval.shopName}. It needs your OK first.`,
        action: { label: "Review and approve", href: `#/approve/${r.id}` },
      });
    }
  }

  // Two problems on one order claim from the same payment, so each order shows only its larger claim.
  const byOrder = new Map<string, NeedsCase>();
  for (const c of input.cases) {
    if (c.status !== "open" || (c.kind !== "price_drop" && c.kind !== "wrong_item")) continue;
    const best = byOrder.get(c.orderId);
    if (!best || c.amountCents > best.amountCents) byOrder.set(c.orderId, c);
  }
  for (const c of byOrder.values()) {
    items.push({
      id: `refund:${c.id}`,
      kind: "refund",
      tone: "ok",
      text:
        c.kind === "price_drop"
          ? `${c.shopName} dropped its price on ${c.itemName}. You can claim ${money(c.amountCents)}.`
          : `${c.shopName} sent the wrong item for ${c.itemName}. You can claim ${money(c.amountCents)}.`,
      action: { label: "Review the refund", href: "#/orders" },
    });
  }

  const idle = open.filter((r) => r.ideas === 0 && !r.approval);
  if (idle.length === 1) {
    items.push({ id: `ready:${idle[0]!.id}`, kind: "ready", tone: "plain", text: `Ready to run: ${idle[0]!.item}.`, action: { label: "Go to my requests", href: "#/" } });
  } else if (idle.length > 1) {
    items.push({ id: "ready", kind: "ready", tone: "plain", text: `${idle.length} requests are ready to run.`, action: { label: "Go to my requests", href: "#/" } });
  }
  return items;
}

/** How many things need the owner's decision. Not counting a shopper that is simply working, or a request that has not been run yet. */
export function badgeCount(items: NeedItem[]): number {
  return items.filter((i) => i.kind !== "working" && i.kind !== "ready").length;
}

/** What to show on the page the owner is looking at: nothing that points at the page they are already on. */
export function visibleNeeds(items: NeedItem[], route: string): NeedItem[] {
  const here = route || "#/";
  return items.flatMap((i) => {
    const target = i.action && "href" in i.action ? i.action.href : null;
    if (target !== here) return [i];
    // Already there: a shopper at work still says so, without a button to the page they are on.
    return i.kind === "working" ? [{ ...i, action: null }] : [];
  });
}

