import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api } from "./api";
import { Note } from "./ui";

const dollars = (s: string): number => Math.round(Number(s) * 100);

// Things the demo shops sell, to show what a request looks like. No price: the shopper finds the real ones.
const EXAMPLES = ["Wireless earbuds", "Bluetooth speaker", "Webcam", "Power bank", "USB-C hub", "Trail socks", "Headlamp", "Water bottle", "First aid kit", "Wool hat", "Mechanical keyboard", "Wireless mouse"];

/** The most to pay when nothing else is said. It is only a ceiling: the shopper chooses the cheapest listing that really is the item. */
const DEFAULT_LIMIT = "150";

// A request is two things: what to buy, and the most to pay. The rest (deadline, shop score, never-buy list)
// has sensible defaults on the server (nothing is banned unless a request says so), and the shopper starts as soon as the request is saved.
/** A request to start filled in: for "raise my limit and search again" or "try again". */
export interface NewPrefill {
  item: string;
  priceCents: number;
  replaces?: string;
}

export function NewRequest({ onClose, onCreated, initial }: { onClose: () => void; onCreated: (id: string) => void; initial?: NewPrefill | null }) {
  const [item, setItem] = useState(() => initial?.item ?? EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]!);
  const [maxPrice, setMaxPrice] = useState(initial ? String(Math.round(initial.priceCents / 100)) : DEFAULT_LIMIT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const made = await api<{ id: string }>("POST", "/api/requests", { kind: "item", item, maxPriceCents: dollars(maxPrice) });
      // The earlier request is closed once the new one exists, so its held money is free again and it is not searched twice.
      if (initial?.replaces) await api("POST", `/api/requests/${initial.replaces}/cancel`, {}).catch(() => undefined);
      onCreated(made.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the request.");
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
        <div className="field">
          <label htmlFor="nr-item">What to buy</label>
          <input id="nr-item" value={item} onChange={(e) => setItem(e.target.value)} />
          <small>Change it to anything you like, or <a href="#/shops" onClick={onClose}><b>see what's available in the shops</b></a>.</small>
        </div>
        <div className="field">
          <label htmlFor="nr-max">Most you will pay ($)</label>
          <input id="nr-max" inputMode="decimal" value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} />
          <small>Including shipping. Your shopper checks all three shops and buys the best match at or under this, without asking you. It is the most it may spend, not what it will spend.</small>
        </div>
        {error && <Note tone="err">{error}</Note>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={saving || item.trim().length < 3 || !(dollars(maxPrice) >= 100)}>{saving ? "Starting…" : "Find and buy it"}</button>
        </div>
      </form>
    </div>
  );
}
