import type { Queryable } from "./db.ts";

export interface Balances {
  monthlyAllowanceCents: number;
  /** Captured payments minus refunds, this calendar month. */
  monthSpentCents: number;
  /** Left over in active requests: set aside minus what they have already spent. */
  setAsideCents: number;
  /** Allowance minus spent minus set aside. Can go negative if the allowance is lowered. */
  freeCents: number;
}

/** Everything here is computed from the ledger and the mandates, never stored. */
export async function getBalances(q: Queryable, userId: string, now: Date = new Date()): Promise<Balances> {
  const res = await q.query<{ allowance: number; spent: number; aside: number }>(
    `select
       (select monthly_allowance_cents from accounts where user_id = $1)::int as allowance,
       coalesce((
         select sum(case kind when 'payment_captured' then amount_cents else -amount_cents end)
         from ledger_entries
         where user_id = $1
           and kind in ('payment_captured', 'refund_received')
           and at >= date_trunc('month', $2::timestamptz)
           and at <  date_trunc('month', $2::timestamptz) + interval '1 month'
       ), 0)::int as spent,
       coalesce((
         select sum(greatest(m.set_aside_cents - coalesce(c.captured, 0), 0))
         from mandates m
         left join (
           select mandate_id, sum(amount_cents) as captured
           from ledger_entries where kind = 'payment_captured' group by mandate_id
         ) c on c.mandate_id = m.id
         where m.user_id = $1 and m.status = 'active'
       ), 0)::int as aside`,
    [userId, now.toISOString()],
  );
  const row = res.rows[0]!;
  if (row.allowance === null) throw new Error("No account for this user.");
  return {
    monthlyAllowanceCents: row.allowance,
    monthSpentCents: row.spent,
    setAsideCents: row.aside,
    freeCents: row.allowance - row.spent - row.aside,
  };
}
