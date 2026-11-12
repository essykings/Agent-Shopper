// What is waiting for the owner, on every page: the bar under the menu and the number in the tab title.
// The deciding is done in src/shared/needs.ts (and tested there).

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { CaseRow, Me, Notice, RequestRow } from "./api";
import { badgeCount, needsYou, visibleNeeds } from "../../src/shared/needs.ts";
import type { NeedItem, NeedsInput } from "../../src/shared/needs.ts";

/** Pages dispatch this after they change something, so the bar updates straight away instead of at the next check. */
export const CHANGED = "agent-shopper:changed";

// While a run is still playing on the map, nothing about its result is announced: not the top message, not the tab count.
// The map trails the real run a little (it shows each step a moment apart), and a result that arrives first gives the ending away.
let held = false;
export function holdUpdates(on: boolean): void {
  const was = held;
  held = on;
  if (was && !on) window.dispatchEvent(new Event(CHANGED));
}

const POLL_MS = 20_000;
const CHECK_MS = 180_000;

function toRequests(list: RequestRow[]): NeedsInput["requests"] {
  return list.map((r) => ({
    id: r.id,
    item: r.item,
    status: r.status,
    hasOrder: r.order !== null,
    ideas: r.kind === "gift" ? r.proposals.length : 0,
    approval:
      r.kind === "item" && r.proposal?.decision === "ask"
        ? { itemName: r.proposal.itemName ?? r.proposal.item_key, shopName: r.proposal.shopName ?? r.proposal.shop_id, totalCents: r.proposal.total_cents }
        : null,
    recipient: r.goal?.recipient ?? null,
  }));
}

export function useNeeds(me: Me | null): { items: NeedItem[]; badge: number; unread: number } {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [cases, setCases] = useState<CaseRow[]>([]);
  const [notices, setNotices] = useState<{ items: Notice[]; unread: number }>({ items: [], unread: 0 });
  const latest = useRef<RequestRow[]>([]);
  const signedIn = me !== null;

  const reload = useCallback(async () => {
    try {
      const [r, c, n] = await Promise.all([
        api<{ requests: RequestRow[] }>("GET", "/api/requests"),
        api<{ cases: CaseRow[] }>("GET", "/api/cases"),
        api<{ items: Notice[]; unread: number }>("GET", "/api/notifications"),
      ]);
      latest.current = r.requests;
      if (held) return; // looked at, but shown only once the map has finished
      setRequests(r.requests);
      setCases(c.cases);
      setNotices(n);
    } catch {
      // Keep what is shown. The next check tries again.
    }
  }, []);

  // Looking for changes: now, every 20 seconds while the tab is visible, when the tab comes back, and when a page says something changed.
  useEffect(() => {
    if (!signedIn) return;
    void reload();
    let pending: number | undefined;
    const soon = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void reload(), 150);
    };
    const timer = window.setInterval(() => !document.hidden && void reload(), POLL_MS);
    const onVisible = () => !document.hidden && soon();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(CHANGED, soon);
    return () => {
      window.clearTimeout(pending);
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(CHANGED, soon);
    };
  }, [signedIn, reload]);

  // Refund cases only appear once the orders have been looked at, so look now and then (only if something was bought).
  useEffect(() => {
    if (!signedIn) return;
    const check = async () => {
      if (document.hidden || !latest.current.some((r) => r.status === "fulfilled")) return;
      try {
        await api("POST", "/api/aftercare/check", {});
        await reload();
      } catch {
        // Not important enough to interrupt anyone.
      }
    };
    const first = window.setTimeout(() => void check(), 3000);
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [signedIn, reload]);

  const items = needsYou({
    paused: me?.paused ?? false,
    paymentSource: me?.payment.source ?? "demo",
    requests: toRequests(requests),
    cases: cases.map((c) => ({ id: c.id, orderId: c.orderId, kind: c.kind, status: c.status, amountCents: c.amountCents, itemName: c.itemName, shopName: c.shopName, failure: c.failure })),
    notices: notices.items.filter((n) => !n.read).map((n) => ({ id: n.id, kind: n.kind, text: n.text })),
    autoRefund: me?.autoRefund ?? false,
  });
  return { items, badge: badgeCount(items), unread: notices.unread };
}

/** One line under the menu: the most important thing waiting, with one button. */
export function NeedsBar({ items, route, onResume }: { items: NeedItem[]; route: string; onResume: () => void }) {
  const shown = visibleNeeds(items, route);
  const first = shown[0];
  if (!first) return null;
  const more = shown.length - 1;
  return (
    <div className="wrap" style={{ padding: "16px clamp(16px,4vw,64px) 0" }}>
      <div className={`needs n-${first.tone}`} role="status" aria-live="polite">
        <span className="pulse" aria-hidden="true" />
        <div className="grow">
          <b>{first.text}</b>
          {first.sub && <div className="s">{first.sub}</div>}
        </div>
        {first.action && ("href" in first.action ? <a className="btn sm" href={first.action.href}>{first.action.label}</a> : <button className="btn sm" onClick={onResume}>{first.action.label}</button>)}
        {more > 0 && <a className="s" href="#/" style={{ fontWeight: 700 }}>+{more} more</a>}
      </div>
    </div>
  );
}
