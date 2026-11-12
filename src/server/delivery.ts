// Delivery. When an order is delivered the owner is asked, in neutral words, to confirm it arrived as ordered. Their answer
// decides what happens: "arrived" closes it; a reported problem is refunded in full only when the shop's own delivery record
// also shows something other than what was ordered (the same evidence as any case). Plain code throughout.

import { findProduct, findShop } from "../shops/catalog.ts";
import { money } from "../shops/pages.ts";
import type { Pool } from "./db.ts";
import { checkOrders, listCases, refundCase } from "./aftercare.ts";
import type { AftercareDeps, RefundResult } from "./aftercare.ts";
import { notify } from "./notifications.ts";

const PAID = ["captured", "payout_pending", "payout_failed", "paid_out"];

const itemNameOf = (shopId: string, key: string | null): string => {
  const shop = findShop(shopId);
  return (shop && key && findProduct(shop, key)?.name) || key || "your order";
};

/** Tells the owner about every delivered order they have not yet confirmed. Each order is told once. Returns how many were new. */
export async function notifyDeliveries(pool: Pool): Promise<number> {
  const rows = await pool.query<{ id: string; user_id: string; shop_id: string; item_key: string | null }>(
    `select o.id, o.user_id, o.shop_id, so.item_key from orders o join shop_orders so on so.order_id = o.id
     where so.status = 'delivered' and o.delivery_answer is null and o.status = any($1) order by so.updated_at limit 200`,
    [PAID],
  );
  let told = 0;
  for (const r of rows.rows) {
    const before = (await pool.query("select 1 from notifications where user_id = $1 and dedupe_key = $2", [r.user_id, `order:${r.id}:delivered`])).rowCount;
    await notify(pool, {
      userId: r.user_id,
      kind: "confirm_delivery",
      text: `Your ${itemNameOf(r.shop_id, r.item_key)} from ${findShop(r.shop_id)?.name ?? "the shop"} was delivered. Please confirm it arrived as ordered.`,
      href: "#/orders",
      key: `order:${r.id}:delivered`,
    });
    if (!before) told++;
  }
  return told;
}

export class DeliveryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface DeliveryOutcome {
  answer: "arrived" | "problem";
  /** Set when a problem was reported and the shop's record backed it up: what was refunded, or why it could not be. */
  refund: RefundResult | null;
  /** In plain words, for the screen. */
  message: string;
}

/** The owner's answer to "did it arrive as ordered?". Can be given once. */
export async function answerDelivery(pool: Pool, deps: AftercareDeps, input: { userId: string; orderId: string; arrived: boolean }): Promise<DeliveryOutcome> {
  const order = (
    await pool.query<{ delivery_answer: string | null; shop_status: string | null; shop_id: string; item_key: string | null; status: string }>(
      `select o.delivery_answer, so.status as shop_status, o.shop_id, so.item_key, o.status
       from orders o left join shop_orders so on so.order_id = o.id where o.id = $1 and o.user_id = $2`,
      [input.orderId, input.userId],
    )
  ).rows[0];
  if (!order || !PAID.includes(order.status)) throw new DeliveryError(404, "Order not found.");
  if (order.shop_status !== "delivered") throw new DeliveryError(409, "This order has not been delivered yet.");
  const answer = input.arrived ? "arrived" : "problem";
  const set = await pool.query("update orders set delivery_answer = $3, delivery_answered_at = now() where id = $1 and user_id = $2 and delivery_answer is null returning id", [input.orderId, input.userId, answer]);
  if (!set.rows[0]) throw new DeliveryError(409, "You have already answered for this order.");
  if (input.arrived) return { answer, refund: null, message: "Thank you. We have noted that it arrived as ordered." };

  // A problem was reported. The same rules as any case decide whether the shop's own record backs it up.
  await checkOrders(pool, deps, input.userId);
  const c = (await listCases(pool, input.userId)).find((x) => x.orderId === input.orderId && x.kind === "wrong_item" && x.status === "open");
  if (!c) {
    return { answer, refund: null, message: "We have saved your report. The shop's delivery record shows the item you ordered, so nothing was refunded." };
  }
  const refund = await refundCase(pool, deps, { userId: input.userId, caseId: c.id });
  if (refund.status === "refunded") {
    await notify(pool, {
      userId: input.userId,
      kind: "refunded",
      text: `You reported a problem with your ${c.itemName} from ${c.shopName}, so you were refunded ${money(refund.amountCents)}.`,
      href: "#/orders",
      key: `case:${c.id}:refunded`,
    });
    return { answer, refund, message: `Thank you. You were refunded ${money(refund.amountCents)}.` };
  }
  return { answer, refund, message: refund.status === "failed" ? `We could not refund it just now: ${refund.reason} You can try again from Orders.` : "We could not refund it. It may already have been refunded." };
}
