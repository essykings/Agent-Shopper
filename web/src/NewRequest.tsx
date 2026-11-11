import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, api } from "./api";
import { Note } from "./ui";

const dollars = (s: string): number => Math.round(Number(s) * 100);

// Things the demo shops really sell, with a price that is enough to buy them. Each time the form opens it suggests
// a different one, so people do not all start with the same earbuds.
const SUGGESTIONS: Array<{ item: string; price: string }> = [
  { item: "Wireless earbuds", price: "60" },
  { item: "Bluetooth speaker", price: "80" },
  { item: "Webcam", price: "50" },
  { item: "Power bank", price: "40" },
  { item: "USB-C hub", price: "60" },
  { item: "Trail socks", price: "50" },
  { item: "Headlamp", price: "50" },
  { item: "Water bottle", price: "35" },
  { item: "First aid kit", price: "35" },
  { item: "Wool hat", price: "30" },
  { item: "Mechanical keyboard", price: "90" },
  { item: "Wireless mouse", price: "35" },
];

// A request is two things: what to buy, and the most to pay. The rest (deadline, shop score, never-buy list)
// has sensible defaults on the server, and the shopper starts as soon as the request is saved.
export function NewRequest({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [start] = useState(() => SUGGESTIONS[Math.floor(Math.random() * SUGGESTIONS.length)]!);
  const [item, setItem] = useState(start.item);
  const [maxPrice, setMaxPrice] = useState(start.price);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const made = await api<{ id: string }>("POST", "/api/requests", { kind: "item", item, maxPriceCents: dollars(maxPrice) });
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
          <small>Including shipping. Your shopper buys the best match at or under this, without asking you.</small>
        </div>
        {error && <Note tone="err">{error}</Note>}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn" disabled={saving}>{saving ? "Starting…" : "Find and buy it"}</button>
        </div>
      </form>
    </div>
  );
}
