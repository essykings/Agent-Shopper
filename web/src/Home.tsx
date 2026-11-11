import { useState } from "react";
import { ApiError, api, money } from "./api";
import type { Me, RequestRow, RunResult, Shop } from "./api";
import { Busy, Intro, Note, Pill, letter, useLoad } from "./ui";

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
  }

  async function cancel(id: string) {
    try {
      await api("POST", `/api/requests/${id}/cancel`, {});
    } catch (err) {
      setErrors((e) => ({ ...e, [id]: err instanceof ApiError ? err.message : "Could not cancel." }));
    }
    requests.reload();
    refreshMe();
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
                const waiting = r.status === "active" && r.proposal?.decision === "ask" && !r.order;
                const busy = running === r.id;
                return (
                  <div className="item" key={r.id}>
                    <div className="mono">{r.kind === "gift" ? "🎁" : letter(r.item)}</div>
                    <div className="grow">
                      <div className="t">{r.item}</div>
                      <div className="s">{r.kind === "gift" ? `Gift · ${r.goal?.interests ? `likes ${r.goal.interests} · ` : ""}` : ""}Up to {money(r.maxPriceCents)} · by {r.deadline} · shops scoring {r.sellerMinScore}+</div>
                    </div>
                    {r.status === "fulfilled" && <Pill tone="ok">Bought {r.order ? money(r.order.total_cents) : ""}</Pill>}
                    {r.status === "cancelled" && <Pill tone="bad">Cancelled</Pill>}
                    {waiting && <Pill tone="warn">{r.kind === "gift" ? "Choose a gift" : "Needs your OK"}</Pill>}
                    {r.status === "active" && !waiting && <Pill tone="warn">Ready</Pill>}
                    <div className="row">
                      {waiting && <a className="btn sm" href={`#/approve/${r.id}`}>{r.kind === "gift" ? `Choose (${r.proposals.length})` : "Review"}</a>}
                      {r.status === "active" && (
                        <button className="btn2 sm" disabled={busy || me.paused || running !== null || me.payment.source === "none"} onClick={() => run(r.id)}>
                          {busy ? <Busy>Shopping…</Busy> : "Run shopper"}
                        </button>
                      )}
                      {r.status === "active" && <button className="btn2 sm" disabled={busy} onClick={() => cancel(r.id)}>Cancel</button>}
                    </div>
                    {busy && <div style={{ flexBasis: "100%" }}><Note>The shopper is looking at the shops. This takes about 20 seconds.</Note></div>}
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
