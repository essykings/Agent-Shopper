import { api } from "./api";
import type { Shop } from "./api";
import { Intro, Note, Pill, letter, useLoad } from "./ui";

export function Shops({ minScore }: { minScore: number }) {
  const shops = useLoad(() => api<{ shops: Shop[] }>("GET", "/api/shops"));
  const list = shops.data?.shops ?? [];
  const trusted = list.filter((s) => s.score >= minScore).length;

  return (
    <>
      <div className="band">
        <Intro
          label="Shops"
          title={<>Where your<br />shopper can buy.</>}
          sub="Every shop gets a trust score before your shopper buys from it. Open a shop to see what it sells."
          panel={
            <div className="panel">
              <span className="tag">Shop scores</span>
              <div className="figs">
                <div><div className="fig">{trusted}</div><div className="lab" style={{ marginTop: 6 }}>Trusted</div></div>
                <div><div className="fig">{list.length - trusted}</div><div className="lab" style={{ marginTop: 6 }}>Not trusted</div></div>
              </div>
              <p className="s" style={{ margin: "14px 0 0" }}>A shop needs {minScore} out of 100 or more.</p>
            </div>
          }
        />
      </div>
      <main className="body">
        <div className="wrap">
          {shops.error && <div style={{ marginBottom: 24 }}><Note tone="err">{shops.error}</Note></div>}
          <section className="card" style={{ marginBottom: 28 }}>
            <h2 className="h2">How the score works</h2>
            <p className="s" style={{ margin: "8px 0 0" }}>
              The score is the shop's trust rating out of 100. It comes from how old the site is, how real its reviews look, and whether its pages try to trick an AI.
              Your shopper never buys from a shop that scores under {minScore}, and it checks the score again before every purchase.
            </p>
          </section>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(320px,1fr))", gap: 28 }}>
            {list.map((s) => (
              <section className="card" key={s.id} style={{ boxShadow: "5px 5px 0 #2B1F3D" }}>
                <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                  <div className="mono">{letter(s.name)}</div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="t" style={{ fontSize: 18 }}>
                      {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "underline" }}>{s.name}<span aria-hidden="true"> ↗</span><span className="sr"> (opens the shop in a new tab)</span></a> : s.name}
                    </div>
                    <div className="s">{s.tagline}</div>
                  </div>
                  <Pill tone={s.score >= minScore ? "ok" : "bad"}>Score {s.score}</Pill>
                </div>
                {s.url && <p style={{ margin: "10px 0 0", fontSize: 14 }}><a href={s.url} target="_blank" rel="noopener noreferrer"><b>Visit {s.name}</b> ↗</a></p>}
              </section>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}
