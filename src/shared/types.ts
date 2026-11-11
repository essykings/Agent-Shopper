// Shared types. All money is whole cents (integers) so nothing ever rounds.

export type Cents = number;

/** The rules you confirmed once. This is the only place your words become rules. */
export interface Mandate {
  id: string;
  /** What you asked for, in plain words. */
  item: string;
  /** "new" means the listing must prove it is new and sealed. */
  condition: "new" | "any";
  /** Most one purchase may cost, shipping included. */
  maxPriceCents: Cents;
  /** Purchases above this need your OK in PayPal. */
  askAboveCents: Cents;
  /** Last day the item may arrive (ISO date, for example 2027-03-01). */
  deadline: string;
  /** Lowest seller score allowed (0 to 100). */
  sellerMinScore: number;
  /** Categories the shopper may never buy. */
  neverBuyCategories: string[];
  /** "gift" means there is no fixed item: the shopper suggests a few and the owner always chooses. Missing means "item". */
  kind?: "item" | "gift";
  /** For gifts: who it is for and why. */
  goal?: GiftGoal;
}

export interface GiftGoal {
  recipient: string;
  occasion: string;
  interests: string;
}

/** One thing the shopper says is true, with the exact words from the page that prove it. */
export interface Claim {
  rule: "item" | "condition";
  quote: string;
}

/** What the shopper agent proposes. It never decides; it only proposes. */
export interface Proposal {
  id: string;
  sellerId: string;
  /** Product identity inside the shop. */
  itemKey: string;
  category: string;
  /** Item plus shipping, as shown when the shopper saved the page. */
  totalCents: Cents;
  /** When the shop says it will arrive (ISO date). Null if the page does not say. */
  deliveryBy: string | null;
  claims: Claim[];
  /** The page text saved when the shopper read it. Quotes are checked against this. */
  snapshotText: string;
  /** The seller checker's score, or null if it could not decide. */
  sellerScore: number | null;
}

export type SellerStatus = "allowed" | "ask_every_time" | "blocked" | "unknown";

/** Facts the guard needs from the database and the shop right now. */
export interface GuardContext {
  now: Date;
  sellerStatus: SellerStatus;
  /** Spent so far this month. */
  monthSpentCents: Cents;
  monthlyAllowanceCents: Cents;
  /** Set aside for this request and not yet spent. */
  requestRemainingCents: Cents;
  /** This request already has an order. */
  alreadyOrdered: boolean;
  /** Price read again from the shop just now, or null if it could not be read. */
  currentTotalCents: Cents | null;
}

export type CheckLevel = "pass" | "ask" | "deny";

export interface Check {
  id: string;
  /** Plain English, shown to the owner as a tick or cross. */
  label: string;
  level: CheckLevel;
  detail: string;
}

export type Decision = "allow" | "ask" | "deny";

export interface GuardResult {
  decision: Decision;
  checks: Check[];
}
