import { useState } from "react";
import { ApiError, api } from "./api";
import type { Shop } from "./api";
import { Intro, Note, Pill, letter, useLoad } from "./ui";

const CHOICES: Array<{ value: Shop["status"]; label: string }> = [
  { value: "allowed", label: "Allowed" },
  { value: "ask_every_time", label: "Ask me" },
  { value: "blocked", label: "Blocked" },
];

export function Shops({ minScore }: { minScore: number }) {
  const shops = useLoad(() => api<{ shops: Shop[] }>("GET", "/api/shops"));
  const [error, setError] = useState<string | null>(null);
  const list = shops.data?.shops ?? [];

  async function choose(id: string, status: Shop["status"]) {
    setError(null);
    try {
      await api("PUT", `/api/shops/${id}`, { status });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save that.");
    }
    shops.reload();
  }

  return (
    <>
      <div className="band">
        <Intro
          label="Shops"
          title={<>Where your<br />shopper can buy.</>}
          sub="It only buys from shops you allow, and checks each one again before every purchase."
          panel={
            <div className="panel">
              <span className="tag">Your shop list</span>
              <div className="figs">
                {CHOICES.map((c) => (
                  <div key={c.value}><div className="fig">{list.filter((s) => s.status === c.value).length}</div><div className="lab" style={{ marginTop: 6 }}>{c.label}</div></div>
                ))}
              </div>
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap">
          {(error || shops.error) && <div style={{ marginBottom: 24 }}><Note tone="err">{error ?? shops.error}</Note></div>}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 28 }}>
            {list.map((s) => (
              <section className="card" key={s.id} style={{ boxShadow: "5px 5px 0 #2B1F3D" }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <div className="mono">{letter(s.name)}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t" style={{ fontSize: 18 }}>{s.name}</div>
                    <div className="s">{s.tagline}</div>
                  </div>
                  <Pill tone={s.score >= minScore ? "ok" : "bad"}>Score {s.score}</Pill>
                </div>
                <ul className="steps" style={{ marginTop: 12 }}>
                  {s.findings.length === 0 && <li>No warning signs found.</li>}
                  {s.findings.slice(0, 4).map((f, i) => <li key={i}>⚠ {f}</li>)}
                </ul>
                <div className="seg" role="group" aria-label={`Choice for ${s.name}`} style={{ marginTop: 14 }}>
                  {CHOICES.map((c) => (
                    <button key={c.value} className={s.status === c.value ? "on" : ""} aria-pressed={s.status === c.value} onClick={() => choose(s.id, c.value)}>{c.label}</button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
