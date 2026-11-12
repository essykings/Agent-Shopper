// What is waiting for the owner right now, worked out from what the app already knows. No screen code
// here, so every state can be tested without a browser. The "Needs you" bar and the tab title use it.

export type NeedKind = "payment" | "paused" | "ideas" | "approval" | "refund" | "delivery" | "notice";
export type NeedTone = "plain" | "ok" | "warn" | "bad";
export type NeedAction = { label: string; href: string } | { label: string; run: "resume" };

export interface NeedItem {
  id: string;
  kind: NeedKind;
  tone: NeedTone;
  text: string;
  /** A smaller second line. */
  sub?: string;
  action: NeedAction | null;
}

export interface NeedsRequest {
  id: string;
  item: string;
  status: string;
  hasOrder: boolean;
  /** Gift ideas waiting for a choice. */
  ideas: number;
  /** A purchase the guard wants the owner's OK for. */
  approval: { itemName: string; shopName: string; totalCents: number } | null;
  /** Who a gift is for. */
  recipient: string | null;
}

export interface NeedsCase {
  id: string;
  orderId: string;
  kind: string;
  status: string;
  amountCents: number;
  itemName: string;
  shopName: string;
  /** Why an automatic refund did not go through, if it was tried and failed. */
  failure: string | null;
}

/** An order that has been delivered and not yet confirmed. */
export interface NeedsDelivery {
  orderId: string;
  itemName: string;
  shopName: string;
}

/** Something the owner has not read yet: what was bought, what was refunded, what went wrong. */
export interface NeedsNotice {
  id: string;
  kind: string;
  text: string;
}

export interface NeedsInput {
  paused: boolean;
  paymentSource: "demo" | "own" | "none";
  requests: NeedsRequest[];
  cases: NeedsCase[];
  /** Delivered orders the owner has not yet confirmed. */
  deliveries: NeedsDelivery[];
  /** Unread notices, newest first. */
  notices: NeedsNotice[];
  /** Refunds are made automatically, so an open case is only worth the owner's attention once an automatic refund has failed. */
  autoRefund: boolean;
}

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Most urgent first. */
export function needsYou(input: NeedsInput): NeedItem[] {
  const items: NeedItem[] = [];

  const open = input.requests.filter((r) => r.status === "active" && !r.hasOrder);

  if (input.paymentSource === "none" && open.length > 0) {
    items.push({ id: "payment", kind: "payment", tone: "warn", text: "Connect a PayPal account so your shopper can buy.", action: { label: "Connect PayPal", href: "#/wallet" } });
  }
  if (input.paused) {
    items.push({ id: "paused", kind: "paused", tone: "warn", text: "Your shopper is paused. It will not run or buy until you resume it.", action: { label: "Resume", run: "resume" } });
  }

  for (const r of open) {
    if (r.ideas > 0) {
      items.push({
        id: `ideas:${r.id}`,
        kind: "ideas",
        tone: "warn",
        text: `Your shopper found ${plural(r.ideas, "gift idea", "gift ideas")}${r.recipient ? ` for ${r.recipient}` : ""}. Nothing is bought until you choose.`,
        action: { label: r.ideas === 1 ? "See the idea" : `See the ${r.ideas} ideas`, href: `#/approve/${r.id}` },
      });
    } else if (r.approval) {
      items.push({
        id: `approval:${r.id}`,
        kind: "approval",
        tone: "warn",
        text: `Your shopper wants to buy ${r.approval.itemName} for ${money(r.approval.totalCents)} from ${r.approval.shopName}. It needs your OK first.`,
        action: { label: "Review and approve", href: `#/approve/${r.id}` },
      });
    }
  }

  // Two problems on one order claim from the same payment, so each order shows only its larger claim.
  const byOrder = new Map<string, NeedsCase>();
  for (const c of input.cases) {
    if (c.status !== "open" || (c.kind !== "price_drop" && c.kind !== "wrong_item")) continue;
    if (input.autoRefund && c.kind === "price_drop" && c.failure === null) continue; // on its way: the app is refunding it
    const best = byOrder.get(c.orderId);
    if (!best || c.amountCents > best.amountCents) byOrder.set(c.orderId, c);
  }
  for (const c of byOrder.values()) {
    items.push({
      id: `refund:${c.id}`,
      kind: "refund",
      tone: input.autoRefund || c.kind === "wrong_item" ? "warn" : "ok",
      // A delivery problem is only ever open here because a refund was tried and failed; a price drop only if refunds are not automatic.
      text:
        c.kind === "wrong_item" || input.autoRefund
          ? `We could not refund ${money(c.amountCents)} for ${c.itemName} from ${c.shopName}. You can refund it yourself.`
          : `${c.shopName} dropped its price on ${c.itemName}. You can claim ${money(c.amountCents)}.`,
      action: { label: c.kind === "wrong_item" || input.autoRefund ? "Open Orders" : "Review the refund", href: "#/orders" },
    });
  }

  // Delivered, and waiting for the owner to say it arrived as ordered. One line for each order.
  for (const d of input.deliveries) {
    items.push({
      id: `delivery:${d.orderId}`,
      kind: "delivery",
      tone: "plain",
      text: `Your ${d.itemName} from ${d.shopName} was delivered. Please confirm it arrived as ordered.`,
      action: { label: "Confirm delivery", href: "#/orders" },
    });
  }

  // The newest thing the owner has not read yet. Opening notifications marks everything read.
  const latest = input.notices[0];
  if (latest) {
    items.push({
      id: `notice:${latest.id}`,
      kind: "notice",
      tone: latest.kind === "refund_failed" ? "warn" : latest.kind === "refunded" ? "ok" : "plain",
      text: latest.text,
      ...(input.notices.length > 1 ? { sub: `${input.notices.length - 1} more ${input.notices.length === 2 ? "notification" : "notifications"} waiting` } : {}),
      action: { label: "Open notifications", href: "#/notifications" },
    });
  }

  return items;
}

/** How many things need the owner's attention: decisions, problems and unread notices. */
export function badgeCount(items: NeedItem[]): number {
  return items.length;
}

/** What to show on the page the owner is looking at: nothing that points at the page they are already on. */
export function visibleNeeds(items: NeedItem[], route: string): NeedItem[] {
  const here = route || "#/";
  return items.filter((i) => (i.action && "href" in i.action ? i.action.href : null) !== here);
}

