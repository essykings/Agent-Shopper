// The walkthrough: five steps that tick themselves from what the owner has really done. It can be hidden,
// and the "How it works" button in the menu brings it back.

import { useEffect, useState } from "react";
import type { CaseRow, RequestRow } from "./api";
import { guideSteps } from "../../src/shared/guide.ts";

const VISITED = "agentShopper.visited";
const HIDDEN = "agentShopper.guideHidden";
const GUIDE_EVENT = "agent-shopper:guide";

type Visited = { town: boolean; playground: boolean; orders: boolean };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser that will not remember is fine: the guide just starts over.
  }
}

/** Remembers which pages have been opened, so the checklist can tick "watch the Town" and "check Orders". */
export function markVisited(route: string): void {
  const key = route.startsWith("#/town") ? "town" : route.startsWith("#/playground") ? "playground" : route.startsWith("#/orders") ? "orders" : null;
  if (!key) return;
  const v = read<Visited>(VISITED, { town: false, playground: false, orders: false });
  if (!v[key]) {
    write(VISITED, { ...v, [key]: true });
    window.dispatchEvent(new Event(GUIDE_EVENT));
  }
}

export function setGuideHidden(hidden: boolean): void {
  write(HIDDEN, hidden);
  window.dispatchEvent(new Event(GUIDE_EVENT));
}

function useGuideState(): { hidden: boolean; visited: Visited } {
  const get = () => ({ hidden: read<boolean>(HIDDEN, false), visited: read<Visited>(VISITED, { town: false, playground: false, orders: false }) });
  const [state, setState] = useState(get);
  useEffect(() => {
    const update = () => setState(get());
    window.addEventListener(GUIDE_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(GUIDE_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return state;
}

export function Guide({ requests, cases, onNew }: { requests: RequestRow[]; cases: CaseRow[]; onNew: () => void }) {
  const { hidden, visited } = useGuideState();
  if (hidden) return null;
  const g = guideSteps({
    requests: requests.map((r) => ({ ran: r.proposal !== null || r.proposals.length > 0 || r.order !== null || r.status === "fulfilled", hasOrder: r.order !== null || r.status === "fulfilled" })),
    visited,
    hasCase: cases.length > 0,
  });
  return (
    <section className="card guide" style={{ flex: "1 1 520px", minWidth: 0 }} aria-label="How it works">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h2 className="h2">Get started</h2>
          <p className="s" style={{ margin: "4px 0 0" }}>{g.doneCount === g.steps.length ? "All five done. You know your way around." : `${g.doneCount} of ${g.steps.length} done. The next step is highlighted.`}</p>
        </div>
        <button className="linkbtn" onClick={() => setGuideHidden(true)}>Hide this</button>
      </div>
      <ol className="gsteps">
        {g.steps.map((s, i) => (
          <li key={s.id} className={`${s.done ? "done" : ""}${i === g.current ? " now" : ""}`}>
            <span className="gnum" aria-label={s.done ? "done" : `step ${i + 1}`}>{s.done ? "✓" : i + 1}</span>
            <div className="grow">
              <b>{s.title}</b>
              <div className="s">{s.text}</div>
            </div>
            {"href" in s.action ? (
              <a className={i === g.current ? "btn sm" : "btn2 sm"} href={s.action.href}>{s.action.label}</a>
            ) : (
              <button className={i === g.current ? "btn sm" : "btn2 sm"} onClick={onNew}>{s.action.label}</button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
