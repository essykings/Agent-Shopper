export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(body !== undefined ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? "Something went wrong. Try again in a moment.", json.code);
  return json as T;
}

export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export interface Balances {
  monthlyAllowanceCents: number;
  monthSpentCents: number;
  setAsideCents: number;
  freeCents: number;
}
export interface Me {
  balances: Balances;
  paused: boolean;
  mock: boolean;
  runsPerDay: number;
  /** Where the money comes from: the shared demo buyer, the person's own PayPal, or nothing yet. */
  payment: { source: "demo" | "own" | "none"; email: string | null };
}
export interface Shop {
  id: string;
  name: string;
  tagline: string;
  score: number;
  findings: string[];
  categories: string[];
  status: "allowed" | "ask_every_time" | "blocked";
}
export interface Check {
  id: string;
  label: string;
  level: "pass" | "ask" | "deny";
  detail: string;
}
export interface Proposal {
  id: string;
  shop_id: string;
  item_key: string;
  total_cents: number;
  decision: "allow" | "ask" | "deny";
  checks: Check[];
  reasoning: string;
  seller_score: number | null;
  delivery_by: string | null;
  /** The product's own name and its shop's name, added by the server. */
  itemName?: string;
  shopName?: string;
}
export interface RequestRow {
  id: string;
  item: string;
  condition: string;
  maxPriceCents: number;
  askAboveCents: number;
  deadline: string;
  sellerMinScore: number;
  neverBuy: string[];
  setAsideCents: number;
  status: "active" | "paused" | "fulfilled" | "expired" | "cancelled";
  createdAt: string;
  proposal: Proposal | null;
  kind: "item" | "gift";
  goal: { recipient: string; occasion: string; interests: string } | null;
  /** For gifts: the ideas from the latest run. */
  proposals: Proposal[];
  order: { id: string; status: string; total_cents: number; shop_id: string } | null;
}
export interface OrderRow {
  id: string;
  status: string;
  totalCents: number;
  shopId: string;
  shopName: string;
  createdAt: string;
  itemKey: string | null;
  /** The product's own name, from the server. */
  itemName?: string;
  /** How much of the payment has been refunded. */
  refundedCents: number;
  shopStatus: "received" | "shipped" | "delivered" | null;
  promisedBy: string | null;
}

/** A problem found with an order, with the evidence for it. */
export interface CaseRow {
  id: string;
  orderId: string;
  kind: "price_drop" | "wrong_item" | "dispute";
  status: "open" | "refunded" | "expired" | "declined" | "closed";
  amountCents: number;
  summary: string;
  evidence: Record<string, any>;
  draft: string | null;
  failure: string | null;
  createdAt: string;
  itemName: string;
  shopName: string;
}
export interface LedgerEntry {
  id: number;
  at: string;
  kind: string;
  amountCents: number;
  detail: Record<string, unknown>;
}
export interface RunResult {
  stage: "agent" | "owner" | "purchase" | "shortlist";
  picks?: Array<{ proposalId: string; totalCents: number }>;
  summary?: string;
  outcome?: { status: string; reason?: string; message?: string };
  proposalId?: string;
  totalCents?: number;
  result?: { status: string; reason?: string; detail?: string; checks?: Check[] };
  actions: Array<{ tool: string; summary: string; ok: boolean }>;
  rejections: Array<{ shopId: string; itemKey: string; reasons: string[] }>;
}
