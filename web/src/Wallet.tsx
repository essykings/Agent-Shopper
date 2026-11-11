import { useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { AllCommunityModule, ModuleRegistry, themeQuartz } from "ag-grid-community";
import type { ColDef } from "ag-grid-community";
import { ApiError, api, money, when } from "./api";
import type { LedgerEntry, Me } from "./api";
import { Busy, Intro, KIND_LABEL, Note, Pill, useLoad } from "./ui";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: "Plus Jakarta Sans, system-ui, sans-serif",
  accentColor: "#2B1F3D",
  foregroundColor: "#2B1F3D",
  backgroundColor: "#FFFFFF",
  borderColor: "#EADFD6",
  headerBackgroundColor: "#FFF6F0",
  fontSize: 14,
});

function detailOf(e: LedgerEntry): string {
  const d = e.detail as { item?: string; event?: string; reason?: string; issues?: Array<{ detail: string }>; totalCents?: number };
  if (e.kind.startsWith("guard_") && d.issues?.length) return d.issues.map((i) => i.detail).join(" ");
  if (e.kind === "note") return [d.event?.replace(/_/g, " "), d.reason].filter(Boolean).join(": ");
  return d.item ?? "";
}

const columns: ColDef<LedgerEntry>[] = [
  { headerName: "When", field: "at", width: 150, valueFormatter: (p) => when(String(p.value)) },
  { headerName: "What happened", field: "kind", width: 230, valueFormatter: (p) => KIND_LABEL[String(p.value)] ?? String(p.value) },
  { headerName: "Amount", field: "amountCents", width: 130, type: "rightAligned", valueFormatter: (p) => (p.value ? money(Number(p.value)) : "") },
  { headerName: "Details", flex: 1, minWidth: 240, valueGetter: (p) => (p.data ? detailOf(p.data) : "") },
];

export function Wallet({ me, refreshMe }: { me: Me; refreshMe: () => void }) {
  const ledger = useLoad(() => api<{ entries: LedgerEntry[] }>("GET", "/api/ledger"), [me.balances.monthSpentCents, me.balances.setAsideCents, me.balances.monthlyAllowanceCents]);
  const [allowance, setAllowance] = useState(String(me.balances.monthlyAllowanceCents / 100));
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const b = me.balances;
  const src = me.payment.source;

  async function connect() {
    setPaying("connect");
    setPayError(null);
    try {
      const r = await api<{ approveUrl: string }>("POST", "/api/paypal/connect", {});
      window.location.href = r.approveUrl; // PayPal's own page, where they sign in and agree
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : "Could not start connecting PayPal.");
      setPaying(null);
    }
  }
  async function switchTo(path: "/api/paypal/disconnect" | "/api/paypal/use-demo") {
    setPaying(path);
    setPayError(null);
    try {
      await api("POST", path, {});
      refreshMe();
    } catch (err) {
      setPayError(err instanceof ApiError ? err.message : "Could not change that.");
    }
    setPaying(null);
  }
  const pct = (n: number) => (b.monthlyAllowanceCents ? Math.min(100, (n / b.monthlyAllowanceCents) * 100) : 0);

  async function save() {
    setMessage(null);
    try {
      await api("POST", "/api/allowance", { monthlyAllowanceCents: Math.round(Number(allowance) * 100) });
      setMessage({ tone: "ok", text: "Allowance saved." });
      refreshMe();
    } catch (err) {
      setMessage({ tone: "err", text: err instanceof ApiError ? err.message : "Could not save." });
    }
  }

  return (
    <>
      <div className="band">
        <Intro
          label="Wallet"
          title={<>Your money.<br />Your limits.</>}
          sub="Your money stays in PayPal until a purchase. The allowance is a limit your shopper can never go over."
          panel={
            <div className="panel">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className="tag">Available to spend</span>
                <span className="lab" style={{ color: "#5E5368" }}>This month</span>
              </div>
              <div className="fig" style={{ fontSize: 64, marginTop: 14 }}>{money(b.freeCents)}</div>
              <div className="meter" role="img" aria-label={`${money(b.monthSpentCents)} spent, ${money(b.setAsideCents)} set aside, ${money(b.freeCents)} free`}>
                <div style={{ width: `${pct(b.monthSpentCents)}%`, background: "#2B1F3D" }} />
                <div style={{ width: `${pct(b.setAsideCents)}%`, background: "#FDD05A", borderLeft: "2px solid #2B1F3D" }} />
              </div>
              <div className="row lab" style={{ marginTop: 10, gap: "6px 18px" }}>
                <span>{money(b.monthSpentCents)} spent</span><span>{money(b.setAsideCents)} set aside</span><span>{money(b.freeCents)} free</span>
              </div>
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap cols">
          <section className="card" style={{ flex: "1 1 340px", maxWidth: 460, display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 className="h2">Pays with</h2>
                {src === "own" && <Pill tone="ok">Your PayPal</Pill>}
                {src === "demo" && <Pill tone="warn">Shared demo buyer</Pill>}
                {src === "none" && <Pill tone="bad">Not connected</Pill>}
              </div>
              <p className="s" style={{ margin: "8px 0 0" }}>
                {src === "own" && `Purchases are charged to your PayPal sandbox account${me.payment.email ? ` (${me.payment.email})` : ""}.`}
                {src === "demo" && "Purchases are charged to a shared sandbox buyer account that comes with the demo."}
                {src === "none" && "Connect a PayPal sandbox account before your shopper can buy."}
                {" "}You sign in on PayPal's own page with your sandbox login. We never see your password.
              </p>
            </div>
            {payError && <Note tone="err">{payError}</Note>}
            <div className="row">
              <button className="btn sm" disabled={paying !== null} onClick={connect}>
                {paying === "connect" ? <Busy>Opening PayPal…</Busy> : src === "own" ? "Switch to another account" : "Use my own sandbox account"}
              </button>
              {src === "own" && <button className="btn2 sm" disabled={paying !== null} onClick={() => switchTo("/api/paypal/disconnect")}>Disconnect</button>}
              {src !== "demo" && <button className="btn2 sm" disabled={paying !== null} onClick={() => switchTo("/api/paypal/use-demo")}>Use the shared demo buyer</button>}
            </div>
            <hr style={{ border: 0, borderTop: "2px solid #EADFD6", margin: "4px 0" }} />
            <h2 className="h2">Monthly allowance</h2>
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="al">Most your shopper can spend in a month ($)</label>
              <input id="al" inputMode="decimal" value={allowance} onChange={(e) => setAllowance(e.target.value)} />
            </div>
            {message && <Note tone={message.tone}>{message.text}</Note>}
            <div className="row" style={{ marginTop: 14 }}><button className="btn" onClick={save}>Save allowance</button></div>
            <p className="s" style={{ marginTop: 18 }}>
              Paid with PayPal. {me.mock ? "In mock mode PayPal is pretend." : "This is the PayPal sandbox, so no real money moves."} Each demo account is limited to {me.runsPerDay} shopper runs a day per network.
            </p>
          </section>
          <section className="card" style={{ flex: "2 1 520px" }}>
            <h2 className="h2">Ledger</h2>
            <p className="s" style={{ margin: "6px 0 14px" }}>Every decision and every movement of money, newest first. Entries are never edited or deleted.</p>
            {ledger.error && <Note tone="err">{ledger.error}</Note>}
            <div style={{ width: "100%" }}>
              <AgGridReact<LedgerEntry> theme={theme} rowData={ledger.data?.entries ?? []} columnDefs={columns} domLayout="autoHeight" suppressCellFocus />
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
