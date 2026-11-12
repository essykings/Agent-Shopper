import { useEffect, useRef, useState } from "react";
import { ApiError, api, money } from "./api";
import type { Me, RequestRow, RunResult } from "./api";
import { MyShopper, useLive } from "./Town";
import type { NewPrefill } from "./NewRequest";
import { giveUpBody } from "../../src/shared/messages.ts";
import { CHANGED, holdUpdates } from "./needs";
import { Busy, Intro, Note, Pill, letter, useLoad } from "./ui";
import type { CaseRow } from "./api";

type GaveUp = { reason?: string; tried?: string[]; closest?: { itemName: string; shopId: string; totalCents: number } | null; limitCents?: number | null };

/** What to say when the shopper decided there was nothing to buy. The reason is the shopper's own short summary. */
export function giveUpMessage(o: GaveUp): { text: string; detail?: string } {
  const tried = (o.tried ?? []).map((q) => (q.startsWith("the ") ? q : `"${q}"`));
  const list = tried.length > 1 ? `${tried.slice(0, -1).join(", ")} and ${tried.at(-1)}` : tried.join("");
  return {
    text: `Nothing was bought. ${giveUpBody(o)}`.trim(),
    ...(list ? { detail: `Searched for ${list}.` } : {}),
  };
}

/** A limit that would buy the closest option, rounded up to a whole $5. */
export const raisedLimitCents = (closestCents: number): number => Math.ceil(closestCents / 500) * 500;

export function summarize(r: RunResult): { tone: "ok" | "warn" | "err"; text: string; detail?: string } {
  if (r.stage === "shortlist") {
    const n = r.picks?.length ?? 0;
    return { tone: "warn", text: `Found ${n} gift idea${n === 1 ? "" : "s"}. Nothing is charged until you choose one.` };
  }
  if (r.stage === "owner") return { tone: "warn", text: `Found it for ${money(r.totalCents ?? 0)}. Nothing is charged until you approve.` };
  if (r.stage === "agent") {
    const o = r.outcome ?? { status: "" };
    if (o.status === "gave_up") return { tone: "warn", ...giveUpMessage(o) };
    if (o.status === "refused") return { tone: "err", text: "The shopper declined this request." };
    if (o.status === "time_limit") return { tone: "warn", text: "The shopper ran out of time before deciding. Nothing was bought. Try again in a moment." };
    if (o.status === "step_limit" || o.status === "token_limit") return { tone: "warn", text: "The shopper ran out of effort before deciding. Nothing was bought." };
    return { tone: "warn", text: o.message || "The shopper did not reach a decision. Nothing was bought." };
  }
  const p = r.result ?? { status: "" };
  switch (p.status) {
    case "paid_out": return { tone: "ok", text: "Bought and paid. The shop has your order." };
    case "payout_pending": return { tone: "warn", text: "You were charged. The shop's payment is still processing." };
    case "payout_failed": return { tone: "warn", text: "You were charged, but paying the shop failed. It can be retried." };
    case "denied": return { tone: "err", text: `Not allowed: ${(p.checks ?? []).filter((c) => c.level === "deny").map((c) => c.detail).join(" ")}` };
    case "cancelled": return { tone: "warn", text: `Stopped at the last check, so nothing was charged. ${p.reason ?? ""}` };
    case "failed": return { tone: "err", text: /fetch failed|no answer|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(p.reason ?? "") ? "PayPal could not be reached just now. Nothing was charged. Try again in a moment." : `PayPal could not complete it. Nothing was charged. ${p.reason ?? ""}`.trim() };
    case "duplicate": return { tone: "warn", text: "That request already has an order." };
    default: return { tone: "warn", text: "Needs your OK before anything is charged." };
  }
}

export function RunPanel({ run }: { run: RunResult }) {
  const s = summarize(run);
  return (
    <div style={{ flexBasis: "100%" }}>
      <Note tone={s.tone}>{s.text}</Note>
      {s.detail && <p className="s" style={{ margin: "6px 0 0" }}>{s.detail}</p>}
      <ul className="steps">
        {run.actions.map((a, i) => (
          <li key={i}>{a.ok ? "✓" : "✗"} {a.summary}</li>
        ))}
      </ul>
      {run.rejections.map((r, i) => (
        <p key={i} className="s" style={{ margin: "6px 0 0" }}>Turned down {r.shopId}: {r.reasons.join(" ")}</p>
      ))}
    </div>
  );
}

export function Home({ me, refreshMe, onNew, startId, onStarted }: { me: Me; refreshMe: () => void; onNew: (prefill?: NewPrefill) => void; startId?: string | null; onStarted?: () => void }) {
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/api/requests"));
  const cases = useLoad(() => api<{ cases: CaseRow[] }>("GET", "/api/cases"));
  const [runs, setRuns] = useState<Record<string, RunResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const live = useLive("/api/live");
  // Several requests can be out at once. A run is "going" until the server answers, then "settling" until the map has finished
  // showing it: until then the request still says it is searching, and the result, the balances and the messages at the top wait,
  // so what you read matches what you see.
  const [going, setGoing] = useState<Set<string>>(new Set());
  const [settling, setSettling] = useState<Set<string>>(new Set());
  const b = me.balances;

  async function run(id: string) {
    holdUpdates(true);
    setGoing((g) => new Set(g).add(id));
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await api<RunResult>("POST", `/api/requests/${id}/run`, {});
      setRuns((x) => ({ ...x, [id]: r }));
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Something went wrong." }));
    }
    setGoing((g) => {
      const next = new Set(g);
      next.delete(id);
      return next;
    });
    setSettling((x) => new Set(x).add(id));
  }

  // When the map has finished, the list is loaded again, and the requests stop saying "searching" only once the new list has
  // arrived (not before, or a request would flash "not finished" for a moment). A slow or failed load does not hold them for long.
  const [reloading, setReloading] = useState(false);
  const listBefore = useRef<unknown>(null);
  const goingNow = useRef(going);
  goingNow.current = going;
  useEffect(() => {
    if (settling.size === 0 || !live.idle || reloading) return;
    listBefore.current = requests.data;
    setReloading(true);
    requests.reload();
    refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settling, live.idle, reloading]);
  useEffect(() => {
    if (!reloading) return;
    const finish = () => {
      setReloading(false);
      setSettling(new Set());
      if (goingNow.current.size === 0) holdUpdates(false); // tells the top message and the tab count to look again
    };
    if (requests.data !== listBefore.current || requests.error) {
      finish();
      return;
    }
    const t = window.setTimeout(finish, 6000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloading, requests.data, requests.error]);
  useEffect(() => () => holdUpdates(false), []);

  // A request that was just created starts looking straight away. Nobody presses Run.
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!startId || started.current === startId) return;
    started.current = startId;
    onStarted?.();
    requests.reload();
    void run(startId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startId]);

  // A request the server is still working on (from before this page was opened) is checked every few seconds until it is done.
  const list = requests.data?.requests ?? [];
  const serverBusy = list.some((r) => r.working && !going.has(r.id) && !settling.has(r.id));
  useEffect(() => {
    if (!serverBusy) return;
    const t = window.setInterval(() => {
      requests.reload();
      refreshMe();
      window.dispatchEvent(new Event(CHANGED));
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverBusy]);

  async function cancel(id: string) {
    try {
      await api("POST", `/api/requests/${id}/cancel`, {});
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Could not cancel." }));
    }
    requests.reload();
    refreshMe();
    window.dispatchEvent(new Event(CHANGED));
  }

  return (
    <>
      <div className="band">
        <Intro
          label="Welcome"
          title={<>Your shopper<br />is on it.</>}
          sub="Tell it what to buy and the most you will pay. It checks the shops, avoids the traps, and buys it for you."
          panel={
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="tag">Available to spend</span>
                <span className="lab" style={{ color: "#5E5368" }}>This month</span>
              </div>
              <div className="figs">
                <div><div className="fig">{money(b.freeCents)}</div><div className="lab" style={{ marginTop: 6 }}>Left of {money(b.monthlyAllowanceCents)}</div></div>
                <div><div className="fig">{money(b.setAsideCents)}</div><div className="lab" style={{ marginTop: 6 }}>Held for requests</div></div>
                <div><div className="fig">{money(b.monthSpentCents)}</div><div className="lab" style={{ marginTop: 6 }}>Spent</div></div>
              </div>
              <div className="row" style={{ marginTop: 20 }}>
                <button className="btn" onClick={() => onNew()}>New request</button>
                <a className="btn2" href="#/wallet">Wallet</a>
              </div>
            </div>
          }
        />
      </div>

      <main className="body">
        <div className="wrap">
          {me.payment.source === "none" && (
            <div style={{ marginBottom: 24 }}>
              <Note tone="warn">No PayPal account is connected, so your shopper can look but not buy. <a href="#/wallet"><b>Connect one on the Wallet page</b></a></Note>
            </div>
          )}
          <div style={{ marginBottom: 32 }}><MyShopper world={live.world} /></div>
          <section className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <h2 className="h2">Your requests</h2>
              <button className="btn sm" onClick={() => onNew()}>New request</button>
            </div>
            {requests.error && <Note tone="err">{requests.error}</Note>}
            {!requests.error && requests.data && list.length === 0 && (
              <div className="empty"><b>Start your first request</b>Tell the shopper what to buy, and how much you will pay.</div>
            )}
            <div style={{ marginTop: 8 }}>
              {list.map((r) => {
                const ideas = r.kind === "gift" ? r.proposals.length : 0;
                const approval = r.kind === "item" && r.proposal?.decision === "ask" ? r.proposal : null;
                const open = r.status === "active" && !r.order;
                const waiting = open && (ideas > 0 || approval !== null);
                const busy = going.has(r.id) || settling.has(r.id) || r.working;
                const closed = r.status === "expired" && r.closedOutcome;
                const closedText = closed && !runs[r.id] ? giveUpMessage({ ...r.closedOutcome!, limitCents: r.maxPriceCents }) : null;
                const raise = closed && r.closedOutcome!.closest ? raisedLimitCents(r.closedOutcome!.closest.totalCents) : null;
                const status =
                  r.status === "fulfilled" ? (
                    <>Bought{r.order ? ` ${money(r.order.total_cents)} (limit ${money(r.maxPriceCents)})` : ""}. <a href="#/orders"><b>See the order</b></a></>
                  ) : r.status === "cancelled" ? (
                    "Cancelled. The money held for it is back in your allowance."
                  ) : r.status === "expired" ? (
                    closedText ? closedText.text : "Not bought. The money held for it is back in your allowance."
                  ) : waiting && ideas > 0 ? (
                    `Waiting for you: your shopper found ${ideas} gift idea${ideas === 1 ? "" : "s"}.`
                  ) : waiting && approval ? (
                    `Waiting for your OK: ${approval.itemName ?? approval.item_key} for ${money(approval.total_cents)} from ${approval.shopName ?? approval.shop_id}.`
                  ) : busy ? (
                    "Your shopper is on it."
                  ) : (
                    "Not finished yet. Your shopper has not decided on this one."
                  );
                return (
                  <div className="item" key={r.id}>
                    <div className="mono">{r.kind === "gift" ? "🎁" : letter(r.item)}</div>
                    <div className="grow">
                      <div className="t">{r.item}</div>
                      <div className="s">{r.kind === "gift" ? `Gift · ${r.goal?.interests ? `likes ${r.goal.interests} · ` : ""}` : ""}Will pay up to {money(r.maxPriceCents)}, shipping included</div>
                      <div className={waiting ? "t" : "s"} style={{ marginTop: 4 }}>{status}</div>
                      {closedText?.detail && <div className="s">{closedText.detail}</div>}
                    </div>
                    {r.status === "fulfilled" && <Pill tone="ok">Bought</Pill>}
                    {r.status === "cancelled" && <Pill tone="bad">Cancelled</Pill>}
                    {r.status === "expired" && <Pill tone="warn">Not bought</Pill>}
                    {waiting && <Pill tone="warn">Waiting for you</Pill>}
                    {open && !waiting && <Pill tone="warn">{busy ? "Searching" : "Not finished"}</Pill>}
                    <div className="row" style={{ alignItems: "center" }}>
                      {waiting && <a className="btn sm" href={`#/approve/${r.id}`}>{ideas > 0 ? (ideas === 1 ? "See the idea" : `See the ${ideas} ideas`) : "Review and approve"}</a>}
                      {open && !waiting && (busy
                        ? <span className="s"><Busy>Searching…</Busy></span>
                        : <button className="btn2 sm" disabled={me.paused || me.payment.source === "none"} onClick={() => run(r.id)}>Search again</button>)}
                      {open && <button className="linkbtn" disabled={busy} onClick={() => cancel(r.id)}>Cancel request</button>}
                    </div>
                    {errors[r.id] && <div style={{ flexBasis: "100%" }}><Note tone="err">{errors[r.id]}</Note></div>}
                    {runs[r.id] && !busy && <RunPanel run={runs[r.id]!} />}
                    {closed && !busy && (
                      <div className="row" style={{ flexBasis: "100%" }}>
                        <button className="btn2 sm" onClick={() => onNew({ item: r.item, priceCents: r.maxPriceCents })}>Try again</button>
                        {raise !== null && <button className="btn sm" onClick={() => onNew({ item: r.item, priceCents: raise })}>Raise my limit to {money(raise)} and search again</button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
