// What the demo shops remember: price changes and the orders they have received.

import type { Pool, Queryable } from "../server/db.ts";
import { SHOPS, findProduct, findShop, wrongItemFor } from "./catalog.ts";

export class ShopControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShopControlError";
  }
}

export interface ShopOrderRow {
  orderId: string;
  shopId: string;
  itemKey: string;
  /** ISO date, for example 2026-11-18. */
  promisedBy: string;
  status: "received" | "shipped" | "delivered";
  /** What was really in the box when it was not what was listed. */
  shippedItem: string | null;
}

const COLUMNS = "order_id, shop_id, item_key, to_char(promised_by, 'YYYY-MM-DD') as promised_by, status, shipped_item";

function toRow(r: Record<string, any>): ShopOrderRow {
  return { orderId: r.order_id, shopId: r.shop_id, itemKey: r.item_key, promisedBy: r.promised_by, status: r.status, shippedItem: r.shipped_item };
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const daysFrom = (now: Date, days: number): string => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
};

/** Makes sure every demo shop and its state row exist. Safe to run again, and from several services. */
export async function seedShops(pool: Pool, payoutEmail: string): Promise<void> {
  for (const s of SHOPS) {
    await pool.query(
      "insert into shops (id, name, payout_email) values ($1, $2, $3) on conflict (id) do update set name = excluded.name, payout_email = excluded.payout_email",
      [s.id, s.name, payoutEmail],
    );
    await pool.query("insert into shop_state (shop_id) values ($1) on conflict (shop_id) do nothing", [s.id]);
  }
}

export async function getPriceAdjust(q: Queryable, shopId: string): Promise<number> {
  const res = await q.query<{ p: number }>("select price_adjust_pct as p from shop_state where shop_id = $1", [shopId]);
  return res.rows[0]?.p ?? 0;
}

export async function setPriceAdjust(pool: Pool, shopId: string, pct: number): Promise<void> {
  if (!findShop(shopId)) throw new ShopControlError("Unknown shop.");
  if (!Number.isInteger(pct) || pct < -90 || pct > 200) throw new ShopControlError("The price change must be a whole number from -90 to 200.");
  await pool.query(
    "insert into shop_state (shop_id, price_adjust_pct) values ($1, $2) on conflict (shop_id) do update set price_adjust_pct = excluded.price_adjust_pct, updated_at = now()",
    [shopId, pct],
  );
}

/** Called when a purchase is paid for: the shop now has an order to ship. */
export async function receiveOrder(pool: Pool, input: { orderId: string; shopId: string; itemKey: string; now?: Date }): Promise<ShopOrderRow> {
  const shop = findShop(input.shopId);
  const product = shop ? findProduct(shop, input.itemKey) : undefined;
  if (!shop || !product) throw new ShopControlError("Unknown shop or item.");
  const promised = daysFrom(input.now ?? new Date(), product.deliveryDays);
  await pool.query(
    "insert into shop_orders (order_id, shop_id, item_key, promised_by) values ($1, $2, $3, $4) on conflict (order_id) do nothing",
    [input.orderId, input.shopId, input.itemKey, promised],
  );
  return (await getShopOrder(pool, input.orderId))!;
}

export async function getShopOrder(q: Queryable, orderId: string): Promise<ShopOrderRow | null> {
  const res = await q.query(`select ${COLUMNS} from shop_orders where order_id = $1`, [orderId]);
  return res.rows[0] ? toRow(res.rows[0]) : null;
}

export async function listShopOrders(q: Queryable): Promise<ShopOrderRow[]> {
  const res = await q.query(`select ${COLUMNS} from shop_orders order by created_at desc limit 50`);
  return res.rows.map(toRow);
}

async function openOrder(pool: Pool, orderId: string): Promise<ShopOrderRow> {
  const o = await getShopOrder(pool, orderId);
  if (!o) throw new ShopControlError("That order was not found.");
  if (o.status === "delivered") throw new ShopControlError("That order was already delivered.");
  return o;
}

/** The shop ships. With wrong set, the box holds a different item, which the shop's own pages never admit. */
export async function shipOrder(pool: Pool, orderId: string, wrong: boolean): Promise<void> {
  const o = await openOrder(pool, orderId);
  const product = findProduct(findShop(o.shopId)!, o.itemKey)!;
  await pool.query("update shop_orders set status = 'shipped', shipped_item = $2, updated_at = now() where order_id = $1", [
    orderId,
    wrong ? wrongItemFor(product) : null,
  ]);
}

/** Moves the promised date to yesterday, so the order is late. */
export async function markLate(pool: Pool, orderId: string, now: Date = new Date()): Promise<void> {
  await openOrder(pool, orderId);
  await pool.query("update shop_orders set promised_by = $2, updated_at = now() where order_id = $1", [orderId, daysFrom(now, -1)]);
}

export async function deliverOrder(pool: Pool, orderId: string): Promise<void> {
  await openOrder(pool, orderId);
  await pool.query("update shop_orders set status = 'delivered', updated_at = now() where order_id = $1", [orderId]);
}
