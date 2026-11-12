// The demo's scripted shop events. A little while after a demo account's purchase, the shop does something the owner
// should hear about, so a judge sees the aftercare story without finding any control panel and without luck:
//   the account's first order: the shop cuts that order's price by 15% (a price drop)
//   the account's second order: the shop ships the wrong item (the owner is then asked to confirm that is what arrived)
// Only demo accounts get events. Each happens once, to one order, and never changes what other people see.

import type { Pool } from "./db.ts";
import { ShopControlError, shipOrder } from "../shops/service.ts";

export const DEMO_PRICE_CUT_PCT = 15;
const PAID = ["captured", "payout_pending", "payout_failed", "paid_out"];

/** Applies every scripted event that is due. Returns how many were applied. */
export async function applyDemoEvents(pool: Pool, opts: { delaySeconds: number }): Promise<number> {
  if (!(opts.delaySeconds > 0)) return 0;
  const due = await pool.query<{ order_id: string; n: number }>(
    `with ranked as (
       select o.id as order_id, o.created_at, so.demo_event,
              row_number() over (partition by o.user_id order by o.created_at, o.id) as n
       from orders o
       join shop_orders so on so.order_id = o.id
       join users u on u.id = o.user_id
       where u.paypal_source = 'demo' and o.status = any($2)
     )
     select order_id, n::int as n from ranked
     where demo_event is null and n <= 2 and created_at <= now() - make_interval(secs => $1)
     order by created_at limit 100`,
    [opts.delaySeconds, PAID],
  );
  let applied = 0;
  for (const row of due.rows) {
    try {
      if (row.n === 1) {
        await pool.query("update shop_orders set price_cut_pct = $2, demo_event = 'price_drop', updated_at = now() where order_id = $1 and demo_event is null", [row.order_id, DEMO_PRICE_CUT_PCT]);
      } else {
        await shipOrder(pool, row.order_id, true);
        await pool.query("update shop_orders set demo_event = 'wrong_item' where order_id = $1 and demo_event is null", [row.order_id]);
      }
      applied++;
    } catch (err) {
      // A delivered order cannot be shipped wrong. Mark it so it is not tried again.
      if (!(err instanceof ShopControlError)) throw err;
      await pool.query("update shop_orders set demo_event = 'none' where order_id = $1 and demo_event is null", [row.order_id]);
    }
  }
  return applied;
}
