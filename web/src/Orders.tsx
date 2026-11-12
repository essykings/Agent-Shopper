import { useEffect, useState } from "react";
import { ApiError, api, money, when } from "./api";
import type { CaseRow, Me, OrderRow } from "./api";
import { CHANGED } from "./needs";
import { Busy, Intro, Note, Pill, letter, useLoad } from "./ui";

const STATUS: Record<string, { tone: "ok" | "warn" | "bad"; text: string }> = {
  paid_out: { tone: "ok", text: "Paid" },
  payout_pending: { tone: "warn", text: "Shop payment processing" },
  payout_failed: { tone: "bad", text: "Shop payment failed" },
  captured: { tone: "warn", text: "Charged" },
  authorized: { tone: "warn", text: "Held" },
  authorizing: { tone: "warn", text: "Starting" },
};

const KIND: Record<CaseRow["kind"], { title: string; button: string }> = {
  price_drop: { title: "The price dropped", button: "Refund me the difference" },
  wrong_item: { title: "A problem with the delivery", button: "Refund me" },
  dispute: { title: "A dispute is open at PayPal", button: "" },
};

const CASE_STATUS: Record<CaseRow["status"], { tone: "ok" | "warn" | "bad"; text: string }> = {
  open: { tone: "warn", text: "Needs you" },
  refunded: { tone: "ok", text: "Refunded" },
  expired: { tone: "bad", text: "No longer applies" },
  declined: { tone: "bad", text: "Declined" },
  closed: { tone: "ok", text: "Closed" },
};

function Evidence({ c }: { c: CaseRow }) {
  const e = c.evidence;
  const row = (label: string, value: string | null | undefined) => (value ? <p style={{ margin: "4px 0" }}><b>{label}:</b> {value}</p> : null);
  return (
    <div style={{ fontSize: 15 }}>
      {row("What you ordered", `${e.order?.item} from ${e.order?.shop}, paid ${money(e.order?.paidCents ?? 0)} on ${when(String(e.order?.orderedAt))}`)}
      {e.listing && row("What the listing said when it was saved", `${e.listing.name}. ${e.listing.condition ?? ""} Total ${money(e.listing.totalCents ?? 0)}.`)}
      {e.listing && row("Proof the page was not changed since", `fingerprint ${String(e.listing.fingerprint).slice(0, 16)}…, saved ${when(String(e.listing.savedAt))}`)}
      {e.arrived && row("What the shop's delivery record lists", e.arrived.description)}
      {e.order?.promisedBy && row("The shop promised delivery by", e.order.promisedBy)}
      {e.order?.priceCutPct > 0 && row("The shop's own order record says", `it cut the price of this item by ${e.order.priceCutPct}% after you ordered`)}
      {e.shopPolicy && row("The shop's returns policy", e.shopPolicy.returns)}
      {e.shopPolicy?.priceProtectionDays > 0 && row("The shop's price protection", `${e.shopPolicy.priceProtectionDays} days`)}
      {Array.isArray(e.timeline) && e.timeline.length > 0 && (
        <>
          <p style={{ margin: "10px 0 4px" }}><b>Timeline</b></p>
          <ul className="steps">
            {e.timeline.map((t: { at: string; event: string; amountCents: number }, i: number) => (
              <li key={i}>{when(t.at)}: {t.event.replace(/_/g, " ")}{t.amountCents ? `, ${money(t.amountCents)}` : ""}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function Orders({ refreshMe, me }: { refreshMe?: () => void; me?: Me }) {
  const auto = me?.autoRefund === true;
  const orders = useLoad(() => api<{ orders: OrderRow[] }>("GET", "/api/orders"));
  const cases = useLoad(() => api<{ cases: CaseRow[] }>("GET", "/api/cases"));
  const [checking, setChecking] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const list = orders.data?.orders ?? [];
  const found = cases.data?.cases ?? [];

  async function check(quiet = false) {
    setChecking(true);
    if (!quiet) setMessage(null);
    try {
      const r = await api<{ cases: CaseRow[] }>("POST", "/api/aftercare/check", {});
      const open = r.cases.filter((c) => c.status === "open").length;
      if (!quiet) setMessage({ tone: open ? "warn" : "ok", text: open ? `Found ${open} thing${open === 1 ? "" : "s"} that need${open === 1 ? "s" : ""} you.` : "Checked your orders. No problems found." });
    } catch (err) {
      if (!quiet) setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not check your orders." });
    }
    setChecking(false);
    cases.reload();
  }

  // Looking is free and refunds nothing, so it is done as the page opens.
  useEffect(() => {
    void check(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refund(c: CaseRow) {
    setWorking(c.id);
    setMessage(null);
    try {
      const r = await api<{ result: { status: string; amountCents?: number; reason?: string; pending?: boolean } }>("POST", `/api/cases/${c.id}/refund`, {});
      const res = r.result;
      if (res.status === "refunded") setMessage({ tone: "ok", text: `Refunded ${money(res.amountCents ?? 0)} to your PayPal${res.pending ? ". PayPal is still finishing it" : ""}.` });
      else setMessage({ tone: res.status === "expired" ? "warn" : "err", text: res.reason ?? "Nothing was refunded." });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Something went wrong. Nothing was refunded." });
    }
    setWorking(null);
    cases.reload();
    orders.reload();
    refreshMe?.();
  }

  // "Did it arrive as ordered?" A problem is refunded only when the shop's own record agrees; the answer says which it was.
  async function confirmDelivery(o: OrderRow, arrived: boolean) {
    setWorking(`delivery-${o.id}`);
    setMessage(null);
    try {
      const r = await api<{ answer: string; refund: { status: string } | null; message: string }>("POST", `/api/orders/${o.id}/delivery`, { arrived });
      setMessage({ tone: r.refund?.status === "refunded" || arrived ? "ok" : "warn", text: r.message });
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not save your answer." });
    }
    setWorking(null);
    orders.reload();
    cases.reload();
    refreshMe?.();
    window.dispatchEvent(new Event(CHANGED));
  }

  async function decline(c: CaseRow) {
    setWorking(c.id);
    try {
      await api("POST", `/api/cases/${c.id}/decline`, {});
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not do that." });
    }
    setWorking(null);
    cases.reload();
  }

  async function draft(c: CaseRow) {
    setWorking(`draft-${c.id}`);
    setMessage(null);
    try {
      const r = await api<{ draft: string }>("POST", `/api/cases/${c.id}/draft`, {});
      setDrafts((d) => ({ ...d, [c.id]: r.draft }));
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not write the message." });
    }
    setWorking(null);
  }

  // Two problems on one order claim from the same payment, so what can be claimed is never more than what is left of it.
  const owed = list.reduce((sum, o) => {
    const claims = found.filter((c) => c.orderId === o.id && c.status === "open" && c.kind !== "dispute" && (!auto || c.kind === "price_drop")).reduce((s, c) => s + c.amountCents, 0);
    return sum + Math.min(claims, Math.max(0, o.totalCents - o.refundedCents));
  }, 0);
  const refunded = list.reduce((s, o) => s + o.refundedCents, 0);

  return (
    <>
      <div className="band">
        <Intro
          label="Orders"
          title={<>Orders and<br />problems.</>}
          sub={auto
            ? "Everything your shopper has bought. If a price drops, your shopper refunds you automatically. When an order is delivered, you confirm it arrived as ordered."
            : "Everything your shopper has bought. If a price drops or a delivery has a problem, your shopper builds the case and you press the button for the refund."}
          panel={
            <div className="panel">
              <span className="tag">Your orders</span>
              <div className="figs">
                <div><div className="fig">{list.length}</div><div className="lab" style={{ marginTop: 6 }}>Orders</div></div>
                <div><div className="fig">{money(owed)}</div><div className="lab" style={{ marginTop: 6 }}>{auto ? "Being refunded" : "You can claim"}</div></div>
                <div><div className="fig">{money(refunded)}</div><div className="lab" style={{ marginTop: 6 }}>Refunded</div></div>
              </div>
              <div className="row" style={{ marginTop: 18 }}>
                <button className="btn" disabled={checking} onClick={() => check()}>{checking ? <Busy>Checking…</Busy> : "Check for problems"}</button>
              </div>
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          {message && <Note tone={message.tone}>{message.text}</Note>}

          {found.length > 0 && (
            <section className="card">
              <h2 className="h2">Problems and refunds</h2>
              <p className="s" style={{ margin: "6px 0 0" }}>
                {auto
                  ? "Price drops are refunded for you. If you report a problem with a delivery and the shop's own record agrees, you are refunded too. The amount is worked out at that moment, so you cannot be refunded more than you are owed."
                  : "Nothing is refunded until you press the button. The amount is worked out again at that moment, so you cannot be refunded more than you are owed."}
              </p>
              <div style={{ marginTop: 8 }}>
                {found.map((c) => {
                  const k = KIND[c.kind];
                  const st = CASE_STATUS[c.status];
                  const isOpen = c.status === "open";
                  return (
                    <div className="item" key={c.id} style={{ alignItems: "flex-start" }}>
                      <div className="mono">{c.kind === "dispute" ? "!" : c.kind === "wrong_item" ? "✗" : "↓"}</div>
                      <div className="grow">
                        <div className="t">{k.title}: {c.itemName}</div>
                        <div className="s">{c.shopName} · {c.summary}</div>
                        {c.failure && c.status !== "refunded" && <div className="s" style={{ color: "#8A1D12", marginTop: 4 }}>{c.failure}</div>}
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 14 }}>The evidence your shopper collected</summary>
                          <div style={{ marginTop: 8 }}><Evidence c={c} /></div>
                        </details>
                        {drafts[c.id] ?? c.draft ? (
                          <div style={{ marginTop: 10 }}>
                            <div className="lab" style={{ marginBottom: 6 }}>Message from your shopper</div>
                            <div className="note" style={{ whiteSpace: "pre-wrap" }}>{drafts[c.id] ?? c.draft}</div>
                          </div>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                        <Pill tone={st.tone}>{isOpen && auto && c.kind === "price_drop" ? (c.failure ? "Needs you" : "Refunding") : st.text}{c.kind !== "dispute" && c.amountCents ? `, ${money(c.amountCents)}` : ""}</Pill>
                        <div className="row" style={{ justifyContent: "flex-end" }}>
                          {isOpen && c.kind !== "dispute" && (
                            <button className="btn sm" disabled={working !== null} onClick={() => refund(c)}>
                              {working === c.id ? <Busy>Refunding…</Busy> : `${k.button} ${money(c.amountCents)}`}
                            </button>
                          )}
                          {(isOpen || c.kind === "dispute") && (
                            <button className="btn2 sm" disabled={working !== null} onClick={() => draft(c)}>
                              {working === `draft-${c.id}` ? <Busy>Writing…</Busy> : drafts[c.id] ?? c.draft ? "Write it again" : "Write the message"}
                            </button>
                          )}
                          {isOpen && c.kind !== "dispute" && <button className="btn2 sm" disabled={working !== null} onClick={() => decline(c)}>Not now</button>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {found.some((c) => c.kind === "dispute") && (
                <p className="s" style={{ marginTop: 14 }}>Disputes are settled at PayPal. Your shopper cannot open one for you, so use the evidence above and the message when you answer PayPal.</p>
              )}
            </section>
          )}

          <section className="card">
            <h2 className="h2">Your orders</h2>
            {orders.error && <Note tone="err">{orders.error}</Note>}
            {orders.data && list.length === 0 && <div className="empty"><b>No orders yet</b>When your shopper buys something, it shows up here.</div>}
            <div style={{ marginTop: 8 }}>
              {list.map((o) => {
                const st = STATUS[o.status] ?? { tone: "warn" as const, text: o.status };
                return (
                  <div className="item" key={o.id}>
                    <div className="mono">{letter(o.shopName)}</div>
                    <div className="grow">
                      <div className="t">{o.itemName ?? "Order"}</div>
                      <div className="s">{o.shopName} · {money(o.totalCents)} · {when(o.createdAt)}</div>
                    </div>
                    <Pill tone={st.tone}>{st.text}</Pill>
                    {o.refundedCents > 0 && <Pill tone="ok">Refunded {money(o.refundedCents)}</Pill>}
                    {o.shopStatus && <span className="s">Shop: {o.shopStatus}{o.promisedBy && o.shopStatus !== "delivered" ? `, promised by ${o.promisedBy}` : ""}</span>}
                    {o.shopStatus === "delivered" && o.deliveryAnswer === null && (
                      <div className="row" style={{ flexBasis: "100%", alignItems: "center" }}>
                        <span className="t">Please confirm it arrived as ordered.</span>
                        <button className="btn sm" disabled={working !== null} onClick={() => confirmDelivery(o, true)}>{working === `delivery-${o.id}` ? <Busy>Saving…</Busy> : "Yes, it arrived as ordered"}</button>
                        <button className="btn2 sm" disabled={working !== null} onClick={() => confirmDelivery(o, false)}>No, there is a problem</button>
                      </div>
                    )}
                    {o.deliveryAnswer === "arrived" && <span className="s">You confirmed it arrived as ordered.</span>}
                    {o.deliveryAnswer === "problem" && <span className="s">You reported a problem with the delivery.</span>}
                  </div>
                );
              })}
            </div>
          </section>
          {cases.error && <Note tone="err">{cases.error}</Note>}
        </div>
      </main>
    </>
  );
}
