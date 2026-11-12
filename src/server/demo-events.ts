// The demo's scripted shop event. A little while after a demo account's FIRST purchase, the shop cuts that order's price by 15%,
// so a judge sees the aftercare story (the price drop, found and refunded automatically) without finding any control panel and
// without luck. It happens once, to one order, and never changes what other people see. Only demo accounts get it.
// (A delivery problem is not staged. The owner's control panel can still make a shop ship the wrong item, to test that path.)

import type { Pool } from "./db.ts";

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
     where demo_event is null and n = 1 and created_at <= now() - make_interval(secs => $1)
     order by created_at limit 100`,
    [opts.delaySeconds, PAID],
  );
  let applied = 0;
  for (const row of due.rows) {
    await pool.query("update shop_orders set price_cut_pct = $2, demo_event = 'price_drop', updated_at = now() where order_id = $1 and demo_event is null", [row.order_id, DEMO_PRICE_CUT_PCT]);
    applied++;
  }
  return applied;
}
