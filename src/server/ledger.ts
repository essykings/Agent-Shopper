import type { Queryable } from "./db.ts";

export const LEDGER_KINDS = [
  "allowance_set",
  "set_aside",
  "set_aside_release",
  "guard_allow",
  "guard_ask",
  "guard_deny",
  "owner_approved",
  "owner_declined",
  "payment_captured",
  "payout_sent",
  "refund_received",
  "dispute_opened",
  "note",
] as const;

export type LedgerKind = (typeof LEDGER_KINDS)[number];

export interface LedgerInput {
  userId: string;
  mandateId?: string;
  kind: LedgerKind;
  /** Whole cents. Always positive; the kind says which way the money went. */
  amountCents?: number;
  /** A retry or repeated webhook with the same key is stored once. */
  idempotencyKey?: string;
  detail?: Record<string, unknown>;
}

export interface LedgerRow {
  id: number;
  at: Date;
  userId: string;
  mandateId: string | null;
  kind: LedgerKind;
  amountCents: number;
  idempotencyKey: string | null;
  detail: Record<string, unknown>;
}

/** Adds one row. Returns duplicate: true if this idempotency key was already stored. */
export async function appendLedger(q: Queryable, input: LedgerInput): Promise<{ id: number; duplicate: boolean }> {
  const amount = input.amountCents ?? 0;
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("Ledger amounts must be whole cents and not negative.");
  }
  const inserted = await q.query<{ id: string }>(
    `insert into ledger_entries (user_id, mandate_id, kind, amount_cents, idempotency_key, detail)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (idempotency_key) do nothing
     returning id`,
    [input.userId, input.mandateId ?? null, input.kind, amount, input.idempotencyKey ?? null, JSON.stringify(input.detail ?? {})],
  );
  if (inserted.rows[0]) return { id: Number(inserted.rows[0].id), duplicate: false };
  const existing = await q.query<{ id: string }>("select id from ledger_entries where idempotency_key = $1", [input.idempotencyKey]);
  return { id: Number(existing.rows[0]!.id), duplicate: true };
}

export async function listLedger(q: Queryable, userId: string, limit = 100): Promise<LedgerRow[]> {
  const res = await q.query(
    `select id, at, user_id, mandate_id, kind, amount_cents, idempotency_key, detail
     from ledger_entries where user_id = $1 order by id desc limit $2`,
    [userId, limit],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    userId: r.user_id,
    mandateId: r.mandate_id,
    kind: r.kind,
    amountCents: Number(r.amount_cents),
    idempotencyKey: r.idempotency_key,
    detail: r.detail,
  }));
}
