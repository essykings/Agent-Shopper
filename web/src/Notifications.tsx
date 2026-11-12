// What happened while the owner was away: purchases, refunds, problems. Opening the page marks everything read,
// so the message at the top of every page goes away. Each line says what happened and links to where to see it.

import { useEffect, useRef } from "react";
import { api, when } from "./api";
import type { Notice } from "./api";
import { CHANGED } from "./needs";
import { Intro, Note, useLoad } from "./ui";

const MARK: Record<Notice["kind"], string> = { bought: "✓", refunded: "↩", refund_failed: "!", not_found: "–", question: "?" };

export function Notifications() {
  const list = useLoad(() => api<{ items: Notice[]; unread: number }>("GET", "/api/notifications"));
  // The ones that were new when the page opened keep a mark, even though they are marked read as it opens.
  const newOnOpen = useRef<Set<string> | null>(null);
  const items = list.data?.items ?? [];

  useEffect(() => {
    if (!list.data || newOnOpen.current) return;
    newOnOpen.current = new Set(list.data.items.filter((n) => !n.read).map((n) => n.id));
    if (list.data.unread > 0) {
      void api("POST", "/api/notifications/read", {})
        .then(() => window.dispatchEvent(new Event(CHANGED)))
        .catch(() => undefined);
    }
  }, [list.data]);

  return (
    <>
      <div className="band">
        <Intro
          label="Notifications"
          title={<>What happened<br />while you were away.</>}
          sub="Purchases, refunds and anything that needs an answer. Price drops are refunded for you, so this is where you hear about them."
        />
      </div>
      <main className="body">
        <div className="wrap">
          <section className="card">
            <h2 className="h2">Latest</h2>
            {list.error && <Note tone="err">{list.error}</Note>}
            {list.data && items.length === 0 && <div className="empty"><b>Nothing yet</b>When your shopper buys something or you are refunded, you will hear about it here.</div>}
            <div style={{ marginTop: 8 }}>
              {items.map((n) => (
                <div className="item" key={n.id}>
                  <div className="mono" aria-hidden="true">{MARK[n.kind]}</div>
                  <div className="grow">
                    <div className="t">{n.text}{newOnOpen.current?.has(n.id) && <span className="newtag">New</span>}</div>
                    <div className="s">{when(n.createdAt)}</div>
                  </div>
                  {n.href && n.href !== "#/notifications" && <a className="btn2 sm" href={n.href}>{n.kind === "not_found" ? "Go to my requests" : n.kind === "question" ? "Check your order" : "See it in Orders"}</a>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
