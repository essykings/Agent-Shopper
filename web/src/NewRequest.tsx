import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api } from "./api";
import { Note } from "./ui";

const dollars = (s: string): number => Math.round(Number(s) * 100);
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
/** The next 20 December, so "a gift for Christmas" starts with a sensible date. */
const nextChristmasCutoff = (): string => {
  const now = new Date();
  const thisYear = new Date(Date.UTC(now.getUTCFullYear(), 11, 20));
  return (thisYear.getTime() >= now.getTime() ? thisYear : new Date(Date.UTC(now.getUTCFullYear() + 1, 11, 20))).toISOString().slice(0, 10);
};

type Kind = "item" | "gift";

export function NewRequest({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<Kind>("item");
  const [item, setItem] = useState("Wireless earbuds");
  const [recipient, setRecipient] = useState("Dad");
  const [occasion, setOccasion] = useState("Christmas");
  const [interests, setInterests] = useState("hiking, coffee");
  const [maxPrice, setMaxPrice] = useState("100");
  const [askAbove, setAskAbove] = useState("100");
  const [deadline, setDeadline] = useState(inDays(90));
  const [minScore, setMinScore] = useState("70");
  const [neverBuy, setNeverBuy] = useState("gift cards, crypto, alcohol");
  const [condition, setCondition] = useState("new");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function choose(k: Kind) {
    setKind(k);
    if (k === "gift") {
      setMaxPrice("80");
      setDeadline(nextChristmasCutoff());
    } else {
      setMaxPrice("100");
      setDeadline(inDays(90));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    const common = {
      condition, maxPriceCents: dollars(maxPrice), deadline, sellerMinScore: Number(minScore),
      neverBuy: neverBuy.split(",").map((s) => s.trim()).filter(Boolean),
    };
    try {
      await api("POST", "/api/requests", kind === "gift" ? { kind, recipient, occasion, interests, ...common } : { kind, item, askAboveCents: dollars(askAbove), ...common });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the request.");
      setSaving(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="New request">
      <form className="card" onSubmit={submit}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h2 className="h2">What should it buy?</h2>
          <button type="button" className="btn2 sm" onClick={onClose}>Close</button>
        </div>
        <div className="seg" role="group" aria-label="Kind of request" style={{ marginBottom: 18 }}>
          <button type="button" className={kind === "item" ? "on" : ""} aria-pressed={kind === "item"} onClick={() => choose("item")}>A specific item</button>
          <button type="button" className={kind === "gift" ? "on" : ""} aria-pressed={kind === "gift"} onClick={() => choose("gift")}>A gift or an occasion</button>
        </div>

        {kind === "item" ? (
          <div className="field">
            <label htmlFor="nr-item">What to buy</label>
            <input id="nr-item" value={item} onChange={(e) => setItem(e.target.value)} />
            <small>The demo shops sell wireless earbuds, a PS5, trail socks, a USB-C hub and about 100 other things each.</small>
          </div>
        ) : (
          <>
            <div className="grid2">
              <div className="field">
                <label htmlFor="nr-who">Who is it for?</label>
                <input id="nr-who" value={recipient} maxLength={30} onChange={(e) => setRecipient(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="nr-occ">What is the occasion?</label>
                <input id="nr-occ" value={occasion} maxLength={30} onChange={(e) => setOccasion(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="nr-likes">What do they like?</label>
              <input id="nr-likes" value={interests} maxLength={200} onChange={(e) => setInterests(e.target.value)} />
              <small>Your shopper suggests up to three gifts. You choose one, and nothing is bought until you do.</small>
            </div>
          </>
        )}

        <div className="grid2">
          <div className="field">
            <label htmlFor="nr-max">{kind === "gift" ? "Most you will spend ($)" : "Most you will pay ($)"}</label>
            <input id="nr-max" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
            <small>Including shipping. This much is set aside from your allowance.</small>
          </div>
          {kind === "item" && (
            <div className="field">
              <label htmlFor="nr-ask">Ask me above ($)</label>
              <input id="nr-ask" inputMode="decimal" value={askAbove} onChange={(e) => setAskAbove(e.target.value)} />
              <small>Above this, nothing is charged until you approve.</small>
            </div>
          )}
          <div className="field">
            <label htmlFor="nr-date">{kind === "gift" ? "Must arrive by" : "Needed by"}</label>
            <input id="nr-date" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="nr-score">Lowest shop score (0 to 100)</label>
            <input id="nr-score" inputMode="numeric" value={minScore} onChange={(e) => setMinScore(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="nr-cond">Condition</label>
            <select id="nr-cond" value={condition} onChange={(e) => setCondition(e.target.value)}>
              <option value="new">Brand new and sealed</option>
              <option value="any">Any condition</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nr-never">Never buy</label>
            <input id="nr-never" value={neverBuy} onChange={(e) => setNeverBuy(e.target.value)} />
            <small>Separate with commas.</small>
          </div>
        </div>
        {error && <Note tone="err">{error}</Note>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={saving}>{saving ? "Saving…" : "Set aside the money and save"}</button>
        </div>
      </form>
    </div>
  );
}
