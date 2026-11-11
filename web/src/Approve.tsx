import { useState } from "react";
import { ApiError, api, money } from "./api";
import type { Proposal, RequestRow } from "./api";
import { Busy, Intro, Note, useLoad } from "./ui";

function Checks({ p }: { p: Proposal }) {
  return (
    <ul className="checks">
      {p.checks.map((c) => (
        <li key={c.id}>
          <span className={`ck ${c.level === "pass" ? "" : c.level}`} aria-label={c.level}>{c.level === "pass" ? "✓" : c.level === "ask" ? "?" : "✗"}</span>
          <span><b>{c.label}.</b> {c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function Approve({ id, refreshMe }: { id: string; refreshMe: () => void }) {
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/api/requests"), [id]);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const req = requests.data?.requests.find((r) => r.id === id);
  const gift = req?.kind === "gift";
  const picks: Proposal[] = req ? (gift ? req.proposals : req.proposal ? [req.proposal] : []) : [];
  const p = picks[0];

  async function approve(pick: Proposal) {
    setWorking(pick.id);
    setMessage(null);
    try {
      const r = await api<{ result: { status: string; reason?: string } }>("POST", `/api/requests/${id}/approve`, { proposalId: pick.id, approvedTotalCents: pick.total_cents });
      if (r.result.status === "paid_out") setMessage({ tone: "ok", text: gift ? `Bought: ${pick.itemName ?? "your gift"}. The shop has your order.` : "Approved, paid, and the shop has your order." });
      else if (r.result.status === "denied" || r.result.status === "cancelled") setMessage({ tone: "warn", text: "The price or your rules changed, so nothing was charged. Run the shopper again." });
      else setMessage({ tone: "warn", text: `Result: ${r.result.status.replace(/_/g, " ")}. ${r.result.reason ?? ""}` });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
    setWorking(null);
    requests.reload();
    refreshMe();
  }

  /** Asks the shopper to look again. The new ideas replace the ones on this page. */
  async function findMore() {
    setWorking("more");
    setMessage(null);
    try {
      await api("POST", `/api/requests/${id}/run`, {});
      setMessage({ tone: "ok", text: "Your shopper looked again. The ideas below are the new ones." });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Something went wrong." });
    }
    setWorking(null);
    requests.reload();
    refreshMe();
  }

  async function decline() {
    try {
      await api("POST", `/api/requests/${id}/cancel`, {});
      setMessage({ tone: "ok", text: "Declined. The money you set aside is free again." });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not decline." });
    }
    requests.reload();
    refreshMe();
  }

  const done = !!req && req.status !== "active";

  if (gift && req) {
    return (
      <>
        <div className="band">
          <Intro
            label="Choose a gift"
            title={<>Gift ideas for<br />{req.goal?.recipient ?? "them"}.</>}
            sub={picks.length ? `Your shopper found ${picks.length} idea${picks.length === 1 ? "" : "s"} for ${req.goal?.occasion ?? "the occasion"}. Nothing is charged until you choose one.` : "There are no ideas to choose from. Run your shopper first."}
          />
        </div>
        <main className="body">
          <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 28 }}>
            {message && <Note tone={message.tone}>{message.text} <a href="#/orders"><b>See orders</b></a></Note>}
            {requests.error && <Note tone="err">{requests.error}</Note>}
            <div className="cols" style={{ alignItems: "stretch" }}>
              {picks.map((pick, i) => (
                <section className="card" key={pick.id} style={{ flex: "1 1 300px", maxWidth: 420, display: "flex", flexDirection: "column", gap: 10 }}>
                  <span className="tag" style={{ alignSelf: "flex-start" }}>Idea {i + 1}</span>
                  <h2 className="h2">{pick.itemName ?? pick.item_key}</h2>
                  <div className="fig" style={{ fontSize: 40 }}>{money(pick.total_cents)}</div>
                  <p className="s" style={{ margin: 0 }}>From {pick.shopName ?? pick.shop_id}. {pick.delivery_by ? `Arrives ${pick.delivery_by}.` : ""} Shop score {pick.seller_score ?? "unknown"} out of 100.</p>
                  {pick.reasoning && <p style={{ margin: "4px 0", fontSize: 16 }}><b>Why this one:</b> {pick.reasoning}</p>}
                  <details>
                    <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>The checks it passed</summary>
                    <Checks p={pick} />
                  </details>
                  <div style={{ marginTop: "auto", paddingTop: 8 }}>
                    <button className="btn" style={{ width: "100%" }} disabled={working !== null || done} onClick={() => approve(pick)}>
                      {working === pick.id ? <Busy>Buying…</Busy> : `Choose this one, ${money(pick.total_cents)}`}
                    </button>
                  </div>
                </section>
              ))}
            </div>
            {picks.length > 0 && (
              <div className="row">
                <button className="btn2" disabled={working !== null || done} onClick={findMore}>{working === "more" ? <Busy>Looking again…</Busy> : "Find different ideas"}</button>
                <button className="linkbtn" disabled={working !== null || done} onClick={decline}>None of these, cancel the request</button>
                <span className="s" style={{ alignSelf: "center" }}>Paid with the sandbox PayPal, so no real money moves.</span>
              </div>
            )}
            {requests.data && !req && <Note tone="warn">That request was not found. <a href="#/"><b>Back home</b></a></Note>}
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <div className="band">
        <Intro
          label="Needs your OK"
          title={req ? req.item : "Approve"}
          sub={p ? `It's asking first because the total is above your ${money(req!.askAboveCents)} limit.` : "Nothing to approve right now."}
          panel={
            p && (
              <div className="panel">
                <span className="tag">Total with shipping</span>
                <div className="fig" style={{ fontSize: 64, marginTop: 14 }}>{money(p.total_cents)}</div>
                <p className="s" style={{ margin: "10px 0 18px" }}>
                  From {p.shop_id}. {p.delivery_by ? `Arrives ${p.delivery_by}.` : ""} Paid with the sandbox PayPal, so no real money moves.
                </p>
                <div className="row">
                  <button className="btn" disabled={working !== null || done} onClick={() => approve(p)}>{working ? <Busy>Paying…</Busy> : "Approve and pay"}</button>
                  <button className="btn2" disabled={working !== null || done} onClick={decline}>Decline</button>
                </div>
              </div>
            )
          }
        />
      </div>
      <main className="body">
        <div className="wrap">
          {message && <div style={{ marginBottom: 24 }}><Note tone={message.tone}>{message.text} <a href="#/orders"><b>See orders</b></a></Note></div>}
          {requests.error && <Note tone="err">{requests.error}</Note>}
          {requests.data && !req && <Note tone="warn">That request was not found. <a href="#/"><b>Back home</b></a></Note>}
          {p && (
            <section className="card" style={{ maxWidth: 760 }}>
              <h2 className="h2">Why your shopper picked it</h2>
              {p.reasoning && <p className="s" style={{ margin: "6px 0 0" }}>{p.reasoning}</p>}
              <Checks p={p} />
            </section>
          )}
        </div>
      </main>
    </>
  );
}
