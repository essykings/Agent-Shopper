// The Playground (your own runs, in full) and the Town square (everyone's runs, anonymous).
// Both draw the same map: an agent walks to a shop, reads a page, checks the seller, goes to the
// guard with a proposal, and pays through PayPal. What happens comes from the server as it happens.

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "./api";
import type { Me, RequestRow, RunResult } from "./api";
import { RunPanel, summarize } from "./Home";
import { Busy, Intro, Note, letter, useLoad } from "./ui";
import type { Feed } from "../../src/shared/events.ts";
import { Player, shopName } from "../../src/shared/world.ts";
import type { AgentView, Place, Tone, World } from "../../src/shared/world.ts";

type Status = "connecting" | "live" | "busy" | "offline";

/** Listens to a live stream and returns what the map should show now. Pauses while the tab is hidden. */
export function useLive(url: string): { world: World; status: Status; idle: boolean } {
  const player = useRef(new Player());
  const [world, setWorld] = useState<World>(player.current.world);
  const [idle, setIdle] = useState(true);
  const [status, setStatus] = useState<Status>("connecting");

  useEffect(() => {
    let es: EventSource | null = null;
    const connect = () => {
      if (es || document.hidden) return;
      setStatus("connecting");
      const source = new EventSource(url);
      es = source;
      source.onopen = () => setStatus((s) => (s === "busy" ? s : "live"));
      source.onmessage = (m) => {
        try {
          player.current.enqueue(JSON.parse(m.data) as Feed, Date.now());
        } catch {
          // A broken message is skipped.
        }
      };
      source.addEventListener("busy", () => {
        setStatus("busy");
        source.close();
        es = null;
      });
      source.onerror = () => setStatus((s) => (s === "busy" ? s : source.readyState === EventSource.CLOSED ? "offline" : "connecting"));
    };
    const disconnect = () => {
      es?.close();
      es = null;
    };
    const onVisible = () => (document.hidden ? disconnect() : connect());
    document.addEventListener("visibilitychange", onVisible);
    connect();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      if (player.current.tick(Date.now())) setWorld(player.current.world);
      setIdle(!player.current.pending());
    }, 150);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
      disconnect();
    };
  }, [url]);

  return { world, status, idle };
}

/** How many tasks have finished today (the whole town's, and the signed-in person's own). Checked now and every 10 seconds. */
export function useTodayCounts(): { total: number | null; mine: number | null } {
  const [counts, setCounts] = useState<{ total: number | null; mine: number | null }>({ total: null, mine: null });
  useEffect(() => {
    let stop = false;
    const look = async () => {
      if (document.hidden) return;
      try {
        const r = await api<{ finishedToday: number; mineToday?: number }>("GET", "/api/town/status");
        if (!stop) setCounts({ total: r.finishedToday, mine: r.mineToday ?? null });
      } catch {
        // Keep the last number. The next check tries again.
      }
    };
    void look();
    const timer = window.setInterval(() => void look(), 10_000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);
  return counts;
}

// ---------- the map ----------

const SHOP_Y: Record<string, number> = { northgear: 110, "deal-zone": 270, trailhead: 430 };
const SHOP_TAG: Record<string, string> = { northgear: "Electronics and gear", "deal-zone": "Unbeatable prices on everything", trailhead: "Outdoor gear for long days" };

function standOf(p: Place): [number, number] {
  if (p.kind === "home") return [190, 270];
  if (p.kind === "gate") return [638, 270];
  if (p.kind === "bank") return [812, 270];
  return [306, SHOP_Y[p.id] ?? 270];
}
const keyOf = (p: Place): string => (p.kind === "shop" ? `shop:${p.id}` : p.kind);

function Agent({ a, x, y }: { a: AgentView; x: number; y: number }) {
  return (
    <div className={`agent${a.place.kind === "shop" ? " atshop" : ""}${a.mine ? " mine" : ""}${a.replay ? " replay" : ""}${a.doneAt !== null ? " done" : ""}`} style={{ transform: `translate(${x - 22}px, ${y - 22}px)` }}>
      <div className={`bubble t-${a.tone}`}>{a.bubble}</div>
      <div className="bot" aria-hidden="true"><i /><i /></div>
      <div className="aname">{a.mine ? `You · ${a.name}` : a.name}</div>
    </div>
  );
}

/** A shopper with nothing to do yet. It rests beside the owner's house, so the map is never empty. It is not a real run. */
function WaitingAgent({ bubble, name }: { bubble: string; name: string }) {
  const [x, y] = standOf({ kind: "home" });
  return (
    <div className="agent idle" style={{ transform: `translate(${x - 22}px, ${y - 22}px)` }}>
      <div className="bubble t-plain">{bubble}</div>
      <div className="bot" aria-hidden="true"><i /><i /></div>
      <div className="aname">{name}</div>
    </div>
  );
}

/** "empty" is what the waiting shopper says. "finished" is the number in the bottom right corner, when there is one. */
export function Scene({ world, homeLabel, empty, finished = null, finishedLabel = "today", compact = false }: { world: World; homeLabel: string; empty: string; finished?: number | null; finishedLabel?: string; compact?: boolean }) {
  const agents = useMemo(() => {
    const list = Object.values(world.agents).sort((a, b) => a.runId.localeCompare(b.runId));
    const seen = new Map<string, number>();
    const total = new Map<string, number>();
    for (const a of list) total.set(keyOf(a.place), (total.get(keyOf(a.place)) ?? 0) + 1);
    return list.map((a) => {
      const k = keyOf(a.place);
      const i = seen.get(k) ?? 0;
      seen.set(k, i + 1);
      const [x, y] = standOf(a.place);
      return { a, x: x - i * 22, y: y + (i - ((total.get(k) ?? 1) - 1) / 2) * 52 };
    });
  }, [world.agents]);
  const coinFrom = standOf({ kind: "bank" });
  const coinTo: [number, number] = world.coin ? [470, SHOP_Y[world.coin.shopId] ?? 270] : [0, 0];
  const gate = world.gateFlash;

  return (
    <div className={`townwrap${compact ? " compact" : ""}`}>
      <div className="town" role="img" aria-label="A map of three shops, the guard's gate and PayPal. Shopping agents walk between them. The list below says what is happening.">
        <svg className="roads" viewBox="0 0 1000 540" aria-hidden="true">
          <g fill="none" stroke="#EADFD6" strokeWidth="22" strokeLinecap="round" strokeLinejoin="round">
            <path d="M140 270H250M250 110V430M250 110H340M250 270H340M250 430H340" />
            <path d="M550 110H606M550 270H606M550 430H606M606 110V430M606 270H668M760 270H860" />
          </g>
        </svg>

        <div className="bld home" style={{ left: 20, top: 205, width: 120, height: 130 }}>
          <span className="dot">{letter(homeLabel)}</span>
          <b>{homeLabel}</b>
          <span className="s">Sets the rules</span>
        </div>

        {Object.entries(SHOP_Y).map(([id, cy]) => {
          const f = world.shopFlash[id];
          return (
            <div key={id} className={`bld shop${id === "deal-zone" ? " sketchy" : ""}`} style={{ left: 340, top: cy - 60, width: 210, height: 120 }}>
              {f && <span className={`chip2 t-${f.tone}`}>{f.text}</span>}
              <span className="dot">{letter(shopName(id))}</span>
              <b>{shopName(id)}</b>
              <span className="s">{SHOP_TAG[id]}</span>
              {id === "deal-zone" && <span className="ribbon">SALE: 62% OFF!</span>}
            </div>
          );
        })}

        <div className="bld gate" style={{ left: 670, top: 195, width: 90, height: 150 }}>
          <span className={`lamp${gate ? ` t-${gate.tone}` : ""}`} aria-hidden="true" />
          <b>Guard</b>
          <span className="s">{gate ? gate.text : "Checks the rules"}</span>
        </div>

        <div className="bld bank" style={{ left: 860, top: 205, width: 120, height: 130 }}>
          <span className="dot">P</span>
          <b>PayPal</b>
          <span className="s">Sandbox money</span>
        </div>

        {world.coin && (
          <div
            key={world.coin.until}
            className="coin"
            style={{ ["--x0" as string]: `${coinFrom[0]}px`, ["--y0" as string]: `${coinFrom[1] - 14}px`, ["--x1" as string]: `${coinTo[0]}px`, ["--y1" as string]: `${coinTo[1] - 14}px` }}
            aria-hidden="true"
          >$</div>
        )}

        {agents.map(({ a, x, y }) => <Agent key={a.runId} a={a} x={x} y={y} />)}
        {agents.length === 0 && <WaitingAgent bubble={empty || "Waiting"} name={homeLabel === "You" ? "Your shopper" : "A shopper"} />}
        {finished !== null && !compact && <div className="tally" role="status">Finished {finished} task{finished === 1 ? "" : "s"} {finishedLabel}</div>}
      </div>
    </div>
  );
}

const TONE_CLASS: Record<Tone, string> = { plain: "", ok: "p-ok", warn: "p-warn", bad: "p-bad" };

function Steps({ world, title, hint }: { world: World; title: string; hint: string }) {
  const lines = [...world.log].reverse().slice(0, 40);
  return (
    <section className="card" style={{ flex: "1 1 360px" }}>
      <h2 className="h2">{title}</h2>
      <p className="s" style={{ margin: "6px 0 10px" }}>{hint}</p>
      {lines.length === 0 ? (
        <div className="empty"><b>Nothing yet</b>Steps appear here as they happen.</div>
      ) : (
        <ol className="feed" aria-live="polite">
          {lines.map((l) => (
            <li key={l.id}>
              <span className={`who${l.mine ? " me" : ""}`}>{l.mine ? "You" : l.agent}</span>
              <span className="pill p-plain">{l.replay ? "Replay" : "Live"}</span>
              <span className="what"><span className={`tdot ${TONE_CLASS[l.tone]}`} aria-hidden="true" />{l.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  connecting: "Connecting…",
  live: "Connected",
  busy: "Too many people are watching right now. Try again in a minute.",
  offline: "Lost the connection. Reload the page to try again.",
};

// ---------- your Playground ----------

export function Playground({ me, refreshMe }: { me: Me; refreshMe: () => void }) {
  const { world, status, idle } = useLive("/api/live");
  const today = useTodayCounts();
  const requests = useLoad(() => api<{ requests: RequestRow[] }>("GET", "/api/requests"));
  const open = (requests.data?.requests ?? []).filter((r) => r.status === "active" && !r.order);
  const [picked, setPicked] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ id: string; run: RunResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = open.find((r) => r.id === picked) ?? open[0];
  const blocked = me.paused ? "Your shopper is paused." : me.payment.source === "none" ? "Connect a PayPal account on the Wallet page first." : null;

  async function run() {
    if (!chosen) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult({ id: chosen.id, run: await api<RunResult>("POST", `/api/requests/${chosen.id}/run`, {}) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    }
    setRunning(false);
    requests.reload();
    refreshMe();
  }

  // The result waits until the scene has finished playing, so it does not give the ending away.
  const summary = result && idle ? summarize(result.run) : null;
  return (
    <>
      <div className="band">
        <Intro
          label="Playground"
          title={<>Watch your<br />shopper work.</>}
          sub="See it walk from shop to shop, check each seller, and face the guard before any money moves."
          panel={
            <div className="panel">
              <span className="tag">Run a request</span>
              {open.length === 0 ? (
                <p style={{ margin: "14px 0 0", fontSize: 16 }}>
                  You have no request waiting. <a href="#/" style={{ fontWeight: 700 }}>Make one on the Home page</a>, then come back to watch it run.
                </p>
              ) : (
                <>
                  <div className="field" style={{ margin: "14px 0" }}>
                    <label htmlFor="pick">Request</label>
                    <select id="pick" value={chosen?.id ?? ""} onChange={(e) => setPicked(e.target.value)} disabled={running}>
                      {open.map((r) => <option key={r.id} value={r.id}>{r.item}, up to ${(r.maxPriceCents / 100).toFixed(2)}</option>)}
                    </select>
                  </div>
                  <button className="btn" style={{ width: "100%" }} disabled={running || !!blocked} onClick={run}>
                    {running ? <Busy>Shopping…</Busy> : "Run shopper"}
                  </button>
                  {blocked && <p className="s" style={{ margin: "10px 0 0" }}>{blocked}</p>}
                </>
              )}
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <h2 className="h2">The town</h2>
              <span className="s" role="status">{STATUS_TEXT[status]}</span>
            </div>
            <Scene world={world} homeLabel="You" empty="Waiting for a request" finished={today.mine ?? today.total} />
          </section>
          {error && <Note tone="err">{error}</Note>}
          {summary && result && (
            <section className="card">
              <h2 className="h2">Result</h2>
              <div style={{ marginTop: 12 }}><RunPanel run={result.run} /></div>
              {(result.run.stage === "owner" || result.run.stage === "shortlist") && <p style={{ marginTop: 14 }}><a className="btn sm" href={`#/approve/${result.id}`}>{result.run.stage === "shortlist" ? "Choose a gift" : "Review and approve"}</a></p>}
            </section>
          )}
          <div className="cols">
            <Steps world={world} title="Steps" hint="What your shopper did, including the guard's reasons. Only you see the reasons." />
          </div>
        </div>
      </main>
    </>
  );
}

/** Your own shopper on the map, for the Home page: live while it works, waiting when it does not. */
export function MyShopper() {
  const { world } = useLive("/api/live");
  const today = useTodayCounts();
  const doing = world.log.at(-1)?.text;
  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 className="h2">Your shopper</h2>
        <span className="s" role="status" aria-live="polite">{doing ?? "Waiting for a request"}</span>
      </div>
      <Scene world={world} homeLabel="You" empty="Waiting for a request" finished={today.mine ?? today.total} />
    </section>
  );
}

// ---------- the public Town square ----------

export function TownSquare({ signedIn }: { signedIn: boolean }) {
  const { world, status } = useLive("/api/town");
  const today = useTodayCounts();
  const [copied, setCopied] = useState<"idle" | "yes" | "no">("idle");
  const link = `${window.location.origin}/#/town`;
  async function share() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
    window.setTimeout(() => setCopied("idle"), 5000);
  }
  const live = Object.keys(world.agents).length > 0;
  const mine = Object.values(world.agents).some((a) => a.mine);
  return (
    <>
      <div className="band">
        <Intro
          label="Town square"
          title={<>Every shopper,<br />live.</>}
          sub="Agents from this demo, shopping right now. Each one is anonymous, and nothing anyone typed is shown."
          panel={
            <div className="panel">
              <span className="tag">{live ? "Live" : "Waiting"}</span>
              <p style={{ margin: "14px 0 16px", fontSize: 16, lineHeight: 1.5 }}>
                {live ? "These are real runs, happening now." : "Nobody is shopping at this moment. A shopper waits here, and real runs appear the moment they start."}
              </p>
              {mine && <p className="s" style={{ margin: "0 0 14px" }}>Your agent has a ring around it and says "You". Only you can tell which one it is.</p>}
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <a className="btn" href="#/">{signedIn ? "Go to my shopper" : "Try it yourself"}</a>
                <button className="btn2" onClick={share}>{copied === "yes" ? "Link copied" : "Share the Town"}</button>
                {signedIn && <a className="s" href="#/playground" style={{ fontWeight: 700 }}>See the private details in the Playground</a>}
              </div>
              {copied === "no" && (
                <div className="field" style={{ margin: "12px 0 0" }}>
                  <label htmlFor="town-link">Copy this link</label>
                  <input id="town-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                </div>
              )}
              <p className="s" style={{ margin: "12px 0 0" }}>Anyone can open this page, with no sign-in.</p>
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap" style={{ display: "flex", flexDirection: "column", gap: 32 }}>
          <section className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
              <h2 className="h2">The town</h2>
              <span className="s" role="status">{STATUS_TEXT[status]}</span>
            </div>
            <Scene world={world} homeLabel="Owner" empty="Waiting for a shopper" finished={today.total} />
          </section>
          <div className="cols">
            <Steps world={world} title="What is happening" hint="Shop names, products, scores and amounts. Never what anyone typed, or why the guard decided." />
          </div>
        </div>
      </main>
    </>
  );
}

/** The Town square for someone who has not signed in: a small header, then the square. */
export function PublicTown() {
  return (
    <div>
      <div style={{ background: "#FDD05A", padding: "20px clamp(16px,4vw,64px) 0" }}>
        <header className="nav wrap">
          <a className="logo" href="#/"><span className="lg">A</span>Agent Shopper</a>
          <div className="navr"><a className="btn sm" href="#/">Try the demo</a></div>
        </header>
      </div>
      <TownSquare signedIn={false} />
    </div>
  );
}
