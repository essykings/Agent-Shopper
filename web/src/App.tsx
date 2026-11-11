import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";
import type { Me } from "./api";
import { Approve } from "./Approve";
import { Home } from "./Home";
import { NewRequest } from "./NewRequest";
import { Orders } from "./Orders";
import { Playground, PublicTown, TownSquare } from "./Town";
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
        label="Agent Shopper · PayPal AI hackathon"
        title={<>A shopper that<br />can't overspend.</>}
        sub="An AI agent browses the shops, avoids the traps, and buys with PayPal. Your rules decide whether any money moves, not the AI."
        panel={
          <div className="panel">
            <span className="tag">Try it</span>
            <p style={{ margin: "14px 0 18px", fontSize: 16, lineHeight: 1.5 }}>
              You get a demo account with a $500 allowance and three pretend shops: an honest one, a scam one, and a flexible one. Payments use the PayPal sandbox, so no real money moves.
            </p>
            <button className="btn" onClick={() => start(false)} disabled={working !== null} style={{ width: "100%" }}>
              {working === "demo" ? <Busy>Setting up…</Busy> : "Try the demo"}
            </button>
            <p className="s" style={{ margin: "10px 0 0" }}>Pays with a shared sandbox buyer account.</p>
            <button className="btn2" onClick={() => start(true)} disabled={working !== null} style={{ width: "100%", marginTop: 16 }}>
              {working === "own" ? <Busy>Opening PayPal…</Busy> : "Use my own sandbox account"}
            </button>
            <p style={{ margin: "18px 0 0", fontSize: 15 }}><a href="#/town" style={{ fontWeight: 700 }}>Watch shoppers live, no sign-in needed →</a></p>
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
  const [version, setVersion] = useState(0);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "warn"; text: string } | null>(() => {
    const code = new URLSearchParams(window.location.search).get("connect");
    return code ? (CONNECT_NOTES[code] ?? null) : null;
  });
  const route = useRoute();

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<Me>("GET", "/api/me"));
      setLoadError(null);
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
  const page = route.startsWith("#/playground") ? "playground" : route.startsWith("#/town") ? "town" : route.startsWith("#/shops") ? "shops" : route.startsWith("#/wallet") ? "wallet" : route.startsWith("#/orders") ? "orders" : "home";
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
          <nav className="links" aria-label="Main">{link("#/", "Home", "home")}{link("#/playground", "Playground", "playground")}{link("#/town", "Town", "town")}{link("#/shops", "Shops", "shops")}{link("#/wallet", "Wallet", "wallet")}{link("#/orders", "Orders", "orders")}</nav>
          <div className="navr">
            <button className="btn sm" onClick={() => setShowNew(true)}>New request</button>
            <button className="btn2 sm" onClick={togglePause}>{me.paused ? "Resume" : "Pause all"}</button>
            <button className="btn2 sm" onClick={signOut}>Sign out</button>
          </div>
        </header>
      </div>
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
        : page === "orders" ? <Orders refreshMe={refreshMe} />
        : <Home me={me} refreshMe={refreshMe} onNew={() => setShowNew(true)} />}
      {showNew && <NewRequest onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); setVersion((v) => v + 1); void refreshMe(); }} />}
    </div>
  );
}
