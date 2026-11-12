import { useCallback, useEffect, useState } from "react";
import { ApiError, SIGNED_OUT, api } from "./api";
import type { Me } from "./api";
import { Approve } from "./Approve";
import { Home } from "./Home";
import { NewRequest } from "./NewRequest";
import type { NewPrefill } from "./NewRequest";
import { Notifications } from "./Notifications";
import { Orders } from "./Orders";
import { Playground, PublicTown, TownSquare } from "./Town";
import { MiniTown } from "./MiniTown";
import { CHANGED, NeedsBar, useNeeds } from "./needs";
import { Shops } from "./Shops";
import { Wallet } from "./Wallet";
import { Busy, Intro, Note } from "./ui";

function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Landing({ onDone }: { onDone: (problem?: string) => void }) {
  const [working, setWorking] = useState<"demo" | "own" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function start(own: boolean) {
    setWorking(own ? "own" : "demo");
    setError(null);
    try {
      await api("POST", "/api/demo/login", { own });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the demo.");
      setWorking(null);
      return;
    }
    if (own) {
      try {
        const r = await api<{ approveUrl: string }>("POST", "/api/paypal/connect", {});
        window.location.href = r.approveUrl; // PayPal's own page, where they sign in and agree
        return;
      } catch (err) {
        onDone(err instanceof ApiError ? err.message : "Could not start connecting PayPal.");
        return;
      }
    }
    onDone();
  }
  return (
    <div className="band" style={{ minHeight: "100vh", justifyContent: "center" }}>
      <Intro
        middle
        label="Agent Shopper · PayPal AI hackathon"
        title={<>A shopper that<br />can't overspend.</>}
        sub="An AI agent browses the shops, avoids the traps, and buys with PayPal. Your rules decide whether any money moves, not the AI."
        panel={
          <div className="panel">
            <div style={{ marginBottom: 20 }}>
              <MiniTown />
              <a href="#/town" style={{ display: "inline-block", marginTop: 8, fontWeight: 700, fontSize: 15 }}>Open the Town, no sign-in needed →</a>
            </div>
            <span className="tag">Try it</span>
            <p style={{ margin: "14px 0 18px", fontSize: 16, lineHeight: 1.5 }}>
              You get a demo account with a $1,000 allowance and three pretend shops: an honest one, a scam one, and a flexible one. Payments use the PayPal sandbox, so no real money moves.
            </p>
            <button className="btn" onClick={() => start(false)} disabled={working !== null} style={{ width: "100%" }}>
              {working === "demo" ? <Busy>Setting up…</Busy> : "Try the demo"}
            </button>
            <p className="s" style={{ margin: "10px 0 0" }}>Pays with a shared sandbox buyer account.</p>
            <button className="btn2" onClick={() => start(true)} disabled={working !== null} style={{ width: "100%", marginTop: 16 }}>
              {working === "own" ? <Busy>Opening PayPal…</Busy> : "Use my own sandbox account"}
            </button>
            <p className="s" style={{ margin: "10px 0 0" }}>
              For people with a PayPal developer account. You sign in on PayPal's own page with your sandbox login. We never see your password.
            </p>
            {error && <div style={{ marginTop: 14 }}><Note tone="err">{error}</Note></div>}
          </div>
        }
      />
    </div>
  );
}

const CONNECT_NOTES: Record<string, { tone: "ok" | "err" | "warn"; text: string }> = {
  connected: { tone: "ok", text: "Your PayPal account is connected. Purchases will be charged to it." },
  failed: { tone: "err", text: "PayPal could not connect that account. Nothing was changed. Try again from the Wallet page." },
  cancelled: { tone: "warn", text: "You cancelled at PayPal, so nothing was connected." },
  signin: { tone: "warn", text: "Please sign in first, then connect your PayPal account from the Wallet page." },
};

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [startId, setStartId] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<NewPrefill | null>(null);
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(() => {
    const code = new URLSearchParams(window.location.search).get("connect");
    return code ? (CONNECT_NOTES[code] ?? null) : null;
  });
  const route = useRoute();
  const needs = useNeeds(me);
  const [shopping, setShopping] = useState(0);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/api/me"));
      setLoadError(null);
      window.dispatchEvent(new Event(CHANGED));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else setLoadError(err instanceof ApiError ? err.message : "Could not reach the server.");
    }
    setChecked(true);
  }, []);
  useEffect(() => {
    void refreshMe();
    // Remove "?connect=..." from the address once it has been read.
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, [refreshMe]);

  // If the server says the sign-in has gone (a restart, or the cookie ran out), any page sends the person back to the start.
  useEffect(() => {
    const out = () => setMe(null);
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, []);

  // The tab title carries the number of things waiting, so it can be noticed from another tab.
  useEffect(() => {
    document.title = me && needs.badge > 0 ? `(${needs.badge}) Agent Shopper` : "Agent Shopper";
  }, [me, needs.badge]);
  // How many shoppers are working right now, for the dot beside "Town".
  useEffect(() => {
    if (!me) return;
    let live = true;
    const look = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ shoppingNow: number }>("GET", "/api/town/status");
        if (live) setShopping(r.shoppingNow);
      } catch {
        // The dot just stays as it was.
      }
    };
    void look();
    const t = window.setInterval(() => void look(), 20_000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [me]);

  if (!checked) return <div className="banner">Loading…</div>;
  if (loadError) return <div className="body"><Note tone="err">{loadError}</Note></div>;
  if (!me && route.startsWith("#/town")) return <PublicTown />;
  if (!me) return <Landing onDone={(problem) => { if (problem) setNote({ tone: "err", text: problem }); void refreshMe(); }} />;

  async function togglePause() {
    await api("POST", "/api/pause", { paused: !me!.paused });
    await refreshMe();
  }
  async function signOut() {
    await api("POST", "/api/logout", {});
    window.location.hash = "#/";
    setMe(null);
  }

  const approve = /^#\/approve\/(.+)$/.exec(route)?.[1];
  const page = route.startsWith("#/playground") ? "playground" : route.startsWith("#/town") ? "town" : route.startsWith("#/shops") ? "shops" : route.startsWith("#/wallet") ? "wallet" : route.startsWith("#/orders") ? "orders" : route.startsWith("#/notifications") ? "notifications" : "home";
  const link = (to: string, label: string, key: string) => (
    <a href={to} className={page === key && !approve ? "on" : ""} aria-current={page === key && !approve ? "page" : undefined}>{label}</a>
  );

  return (
    <div key={version}>
      {me.mock && <div className="banner">Mock mode: the shopper is scripted and PayPal is pretend. Nothing here costs money.</div>}
      {me.paused && <div className="banner" style={{ background: "#FFE7A0", color: "#5A3A00" }}>Your shopper is paused. It will not run or buy until you resume it.</div>}
      <div style={{ background: "#FDD05A", padding: "20px clamp(16px,4vw,64px) 0" }}>
        <header className="nav wrap">
          <a className="logo" href="#/"><span className="lg">A</span>Agent Shopper</a>
          <nav className="links" aria-label="Main">{link("#/", "Home", "home")}{link("#/playground", "Playground", "playground")}<a href="#/town" className={page === "town" && !approve ? "on" : ""} aria-current={page === "town" && !approve ? "page" : undefined}>Town{shopping > 0 && <span className="live" aria-label={`${shopping} shopper${shopping === 1 ? "" : "s"} working now`}><i aria-hidden="true" />{shopping}</span>}</a>{link("#/shops", "Shops", "shops")}{link("#/wallet", "Wallet", "wallet")}{link("#/orders", "Orders", "orders")}</nav>
          <div className="navr">
            <a className={`btn2 sm bell${page === "notifications" ? " on" : ""}`} href="#/notifications" aria-label={needs.unread > 0 ? `Notifications, ${needs.unread} new` : "Notifications"}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></svg>
              {needs.unread > 0 && <span className="bellcount">{needs.unread > 9 ? "9+" : needs.unread}</span>}
            </a>
            <button className="btn sm" onClick={() => { setPrefill(null); setShowNew(true); }}>New request</button>
            <button className="btn2 sm" onClick={togglePause}>{me.paused ? "Resume" : "Pause all"}</button>
            <button className="btn2 sm" onClick={signOut}>Sign out</button>
          </div>
        </header>
      </div>
      <NeedsBar items={needs.items} route={route || "#/"} onResume={togglePause} />
      {note && (
        <div className="wrap" style={{ padding: "20px clamp(16px,4vw,64px) 0" }}>
          <Note tone={note.tone}>{note.text} <button className="btn2 sm" style={{ marginLeft: 8 }} onClick={() => setNote(null)}>Dismiss</button></Note>
        </div>
      )}
      {approve ? <Approve id={approve} refreshMe={refreshMe} />
        : page === "playground" ? <Playground me={me} refreshMe={refreshMe} />
        : page === "town" ? <TownSquare signedIn />
        : page === "shops" ? <Shops minScore={70} />
        : page === "wallet" ? <Wallet me={me} refreshMe={refreshMe} />
        : page === "orders" ? <Orders refreshMe={refreshMe} me={me} />
        : page === "notifications" ? <Notifications />
        : <Home me={me} refreshMe={refreshMe} onNew={(p) => { setPrefill(p ?? null); setShowNew(true); }} startId={startId} onStarted={() => setStartId(null)} />}
      {showNew && <NewRequest initial={prefill} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); setStartId(id); window.location.hash = "#/"; void refreshMe(); }} />}
    </div>
  );
}
