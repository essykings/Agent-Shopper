// Automatic aftercare. The shop's price drops and the owner is refunded without doing anything: this finds the problem, the
// same rules as the button decide the amount, PayPal refunds, and a notice tells the owner. A price drop is a fact on the
// shop's page that code can check. A wrong item is not: only the owner knows what arrived, so that one is always asked.
// A refund that fails is tried again a few times, a while apart, and then left for the owner to press the button.

import { money } from "../shops/pages.ts";
import { applyDemoEvents } from "./demo-events.ts";
import type { Pool } from "./db.ts";
import { checkOrders, listCases, refundCase } from "./aftercare.ts";
import type { AftercareDeps, CaseKind, RefundResult } from "./aftercare.ts";
import { notify } from "./notifications.ts";

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 10;
/** How far back orders are looked at. A shop's price protection lasts 14 days. */
const LOOK_BACK_DAYS = 15;
const PAID = ["captured", "payout_pending", "payout_failed", "paid_out"];

export interface AutoRefund {
  userId: string;
  caseId: string;
  kind: CaseKind;
  result: RefundResult;
}

/** Refunds every open price-drop case that is due an attempt. Everyone's, or one person's. A wrong item is never refunded here. */
export async function refundOpenCases(pool: Pool, deps: AftercareDeps, opts: { userId?: string } = {}): Promise<AutoRefund[]> {
  const due = await pool.query<{ id: string; user_id: string; kind: CaseKind; auto_attempts: number }>(
    `select id, user_id, kind, auto_attempts from cases
     where status = 'open' and kind = 'price_drop' and auto_attempts < $1
       and (auto_attempt_at is null or auto_attempt_at < now() - make_interval(mins => $2))
       and ($3::uuid is null or user_id = $3::uuid)
     order by created_at limit 100`,
    [MAX_ATTEMPTS, RETRY_AFTER_MINUTES, opts.userId ?? null],
  );
  const done: AutoRefund[] = [];
  for (const row of due.rows) {
    // Count the attempt first, so a crash can never turn into an endless loop.
    const attempts = (await pool.query<{ n: number }>("update cases set auto_attempts = auto_attempts + 1, auto_attempt_at = now() where id = $1 returning auto_attempts as n", [row.id])).rows[0]!.n;
    const result = await refundCase(pool, deps, { userId: row.user_id, caseId: row.id });
    const c = (await listCases(pool, row.user_id)).find((x) => x.id === row.id);
    const what = c ? `${c.itemName} from ${c.shopName}` : "your order";
    if (result.status === "refunded") {
      await notify(pool, {
        userId: row.user_id,
        kind: "refunded",
        text: `${c?.shopName ?? "The shop"} cut its price on ${c?.itemName ?? "your order"}, so you were refunded ${money(result.amountCents)} automatically.`,
        href: "#/orders",
        key: `case:${row.id}:refunded`,
      });
    } else if (result.status === "failed") {
      await notify(pool, {
        userId: row.user_id,
        kind: "refund_failed",
        text:
          attempts >= MAX_ATTEMPTS
            ? `We could not refund ${what} automatically: ${result.reason} Open Orders to refund it yourself.`
            : `We could not refund ${what} yet: ${result.reason} We will try again.`,
        href: "#/orders",
        key: `case:${row.id}:failed:${attempts}`,
      });
    }
    done.push({ userId: row.user_id, caseId: row.id, kind: row.kind, result });
  }
  return done;
}

/** One pass for everyone: scripted demo events that are due, then every recent paid order is checked and (if refund is on) refunded if owed. */
export async function runAftercareSweep(pool: Pool, deps: AftercareDeps, opts: { demoEventSeconds?: number } = {}, refund = true): Promise<{ events: number; refunds: number }> {
  const events = await applyDemoEvents(pool, { delaySeconds: opts.demoEventSeconds ?? 0 });
  const users = await pool.query<{ user_id: string }>(
    "select distinct user_id from orders where status = any($1) and created_at > now() - make_interval(days => $2) limit 200",
    [PAID, LOOK_BACK_DAYS],
  );
  let refunds = 0;
  for (const u of users.rows) {
    try {
      await checkOrders(pool, deps, u.user_id);
      if (refund) refunds += (await refundOpenCases(pool, deps, { userId: u.user_id })).filter((r) => r.result.status === "refunded").length;
    } catch (err) {
      console.error(`Aftercare for one person failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { events, refunds };
}
