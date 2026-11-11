// Reads the facts the guard needs from the database, fresh for each proposal.

import { getBalances } from "../server/balances.ts";
import type { Pool } from "../server/db.ts";
import type { Proposal, SellerStatus } from "../shared/types.ts";
import type { GuardFacts } from "./shopper.ts";

export function dbGuardFacts(
  pool: Pool,
  opts: { userId: string; mandateId: string; getSellerStatus: (shopId: string) => Promise<SellerStatus>; now?: () => Date },
): (proposal: Proposal) => Promise<GuardFacts> {
  return async (proposal) => {
    const now = (opts.now ?? (() => new Date()))();
    const [balances, mandate, captured, existing, sellerStatus] = await Promise.all([
      getBalances(pool, opts.userId, now),
      pool.query<{ set_aside_cents: number }>("select set_aside_cents from mandates where id = $1 and user_id = $2", [opts.mandateId, opts.userId]),
      pool.query<{ n: number }>("select coalesce(sum(amount_cents), 0)::int as n from ledger_entries where mandate_id = $1 and kind = 'payment_captured'", [opts.mandateId]),
      pool.query<{ e: boolean }>("select exists(select 1 from orders where mandate_id = $1 and status not in ('cancelled', 'failed')) as e", [opts.mandateId]),
      opts.getSellerStatus(proposal.sellerId),
    ]);
    if (!mandate.rows[0]) throw new Error("Request not found.");
    return {
      now,
      sellerStatus,
      monthSpentCents: balances.monthSpentCents,
      monthlyAllowanceCents: balances.monthlyAllowanceCents,
      requestRemainingCents: mandate.rows[0].set_aside_cents - captured.rows[0]!.n,
      alreadyOrdered: existing.rows[0]!.e,
    };
  };
}
