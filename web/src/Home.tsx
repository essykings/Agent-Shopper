import { useState } from "react";
import { ApiError, api, money } from "./api";
import type { Me, RequestRow, RunResult, Shop } from "./api";
import { Guide } from "./Guide";
import { MiniTown } from "./MiniTown";
import { CHANGED } from "./needs";
import { Busy, Intro, Note, Pill, letter, useLoad } from "./ui";
import type { CaseRow } from "./api";

export function summarize(r: RunResult): { tone: "ok" | "warn" | "err"; text: string } {
  if (r.stage === "shortlist") {
    const n = r.picks?.length ?? 0;
    return { tone: "warn", text: `Found ${n} gift idea${n === 1 ? "" : "s"}. Nothing is charged until you choose one.` };
  }
  if (r.stage === "owner") return { tone: "warn", text: `Found it for ${money(r.totalCents ?? 0)}. Nothing is charged until you approve.` };
  if (r.stage === "agent") {
    const o = r.outcome ?? { status: "" };
    if (o.status === "gave_up") return { tone: "warn", text: `Nothing fit your rules. ${o.reason ?? ""}` };
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
    case "failed": return { tone: "err", text: `PayPal could not complete it. Nothing was charged. ${p.reason ?? ""}` };
    case "duplicate": return { tone: "warn", text: "That request already has an order." };
    default: return { tone: "warn", text: "Needs your OK before anything is charged." };
  }
}

export function RunPanel({ run }: { run: RunResult }) {
  const s = summarize(run);
  return (
    <div style={{ flexBasis: "100%" }}>
      <Note tone={s.tone}>{s.text}</Note>
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

export function Home({ me, refreshMe, onNew }: { me: Me; refreshMe: () => void; onNew: () => void }) {
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/api/requests"));
  const shops = useLoad(() => api<{ shops: Shop[] }>("GET", "/api/shops"));
  const cases = useLoad(() => api<{ cases: CaseRow[] }>("GET", "/api/cases"));
  const [running, setRunning] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunResult>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const b = me.balances;

  async function run(id: string) {
    setRunning(id);
    setErrors((e) => ({ ...e, [id]: "" }));
    try {
      const r = await api<RunResult>("POST", `/api/requests/${id}/run`, {});
      setRuns((x) => ({ ...x, [id]: r }));
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Something went wrong." }));
    }
    setRunning(null);
    requests.reload();
    refreshMe();
    window.dispatchEvent(new Event(CHANGED));
  }

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

  const list = requests.data?.requests ?? [];
  return (
    <>
      <div className="band">
        <Intro
          label="Welcome"
          title={<>Your shopper<br />is on it.</>}
          sub="Tell it what to buy. It checks the shops, avoids the traps, and asks you before it spends past your limit."
          panel={
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="tag">Available to spend</span>
                <span className="lab" style={{ color: "#5E5368" }}>This month</span>
              </div>
              <div className="figs">
                <div><div className="fig">{money(b.freeCents)}</div><div className="lab" style={{ marginTop: 6 }}>Free of {money(b.monthlyAllowanceCents)}</div></div>
                <div><div className="fig">{money(b.setAsideCents)}</div><div className="lab" style={{ marginTop: 6 }}>Set aside</div></div>
                <div><div className="fig">{money(b.monthSpentCents)}</div><div className="lab" style={{ marginTop: 6 }}>Spent</div></div>
              </div>
              <div className="row" style={{ marginTop: 20 }}>
                <button className="btn" onClick={onNew}>New request</button>
                <a className="btn2" href="#/wallet">Wallet</a>
              </div>
            </div>
          }
        />
        <section className="wrap" style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "center", justifyContent: "space-between" }}>
          <div className="lab">Your shops</div>
          <div className="chips">
            {(shops.data?.shops ?? []).map((s) => (
              <a key={s.id} className="chip" href="#/shops"><span className="dot">{letter(s.name)}</span>{s.name}</a>
            ))}
          </div>
        </section>
      </div>

      <main className="body">
        <div className="wrap">
          {me.payment.source === "none" && (
            <div style={{ marginBottom: 24 }}>
              <Note tone="warn">No PayPal account is connected, so your shopper can look but not buy. <a href="#/wallet"><b>Connect one on the Wallet page</b></a></Note>
            </div>
          )}
          <div className="cols" style={{ alignItems: "flex-start", marginBottom: 32 }}>
            <Guide requests={list} cases={cases.data?.cases ?? []} onNew={onNew} />
            <section className="card" style={{ flex: "1 1 380px", maxWidth: 520, minWidth: 0 }}>
              <h2 className="h2">Watch the town</h2>
              <p className="s" style={{ margin: "4px 0 14px" }}>Your shopper walks between the shops, the guard and PayPal. This is the same map as the Town page.</p>
              <MiniTown />
              <a className="btn2 sm" href="#/town" style={{ marginTop: 14 }}>Open the Town</a>
            </section>
          </div>
          <section className="card">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <h2 className="h2">Your requests</h2>
              <button className="btn sm" onClick={onNew}>New request</button>
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
                const busy = running === r.id;
                const status =
                  r.status === "fulfilled" ? (
                    <>Bought{r.order ? ` ${money(r.order.total_cents)}` : ""}. <a href="#/orders"><b>See the order</b></a></>
                  ) : r.status === "cancelled" ? (
                    "Cancelled. The money set aside is free again."
                  ) : waiting && ideas > 0 ? (
                    `Waiting for you: your shopper found ${ideas} gift idea${ideas === 1 ? "" : "s"}.`
                  ) : waiting && approval ? (
                    `Waiting for your OK: ${approval.itemName ?? approval.item_key} for ${money(approval.total_cents)} from ${approval.shopName ?? approval.shop_id}.`
                  ) : (
                    "Ready. Press Run shopper to send it to the shops."
                  );
                return (
                  <div className="item" key={r.id}>
                    <div className="mono">{r.kind === "gift" ? "🎁" : letter(r.item)}</div>
                    <div className="grow">
                      <div className="t">{r.item}</div>
                      <div className="s">{r.kind === "gift" ? `Gift · ${r.goal?.interests ? `likes ${r.goal.interests} · ` : ""}` : ""}Up to {money(r.maxPriceCents)} · by {r.deadline} · shops scoring {r.sellerMinScore}+</div>
                      <div className={waiting ? "t" : "s"} style={{ marginTop: 4 }}>{status}</div>
                    </div>
                    {r.status === "fulfilled" && <Pill tone="ok">Bought</Pill>}
                    {r.status === "cancelled" && <Pill tone="bad">Cancelled</Pill>}
                    {waiting && <Pill tone="warn">Waiting for you</Pill>}
                    {open && !waiting && <Pill tone="warn">Ready</Pill>}
                    <div className="row" style={{ alignItems: "center" }}>
                      {waiting && <a className="btn sm" href={`#/approve/${r.id}`}>{ideas > 0 ? (ideas === 1 ? "See the idea" : `See the ${ideas} ideas`) : "Review and approve"}</a>}
                      {open && !waiting && (
                        <button className="btn sm" disabled={busy || me.paused || running !== null || me.payment.source === "none"} onClick={() => run(r.id)}>
                          {busy ? <Busy>Shopping…</Busy> : "Run shopper"}
                        </button>
                      )}
                      {open && <button className="linkbtn" disabled={busy} onClick={() => cancel(r.id)}>Cancel request</button>}
                    </div>
                    {busy && <div style={{ flexBasis: "100%" }}><Note>The shopper is looking at the shops. This takes about 20 seconds. <a href="#/town"><b>Watch it in the Town</b></a></Note></div>}
                    {errors[r.id] && <div style={{ flexBasis: "100%" }}><Note tone="err">{errors[r.id]}</Note></div>}
                    {runs[r.id] && <RunPanel run={runs[r.id]!} />}
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
