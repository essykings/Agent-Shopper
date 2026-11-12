// What the owner is told, kept in the database so it is still there on another device and after a restart.
// Notices are plain sentences. Nothing here decides anything.

import type { Pool } from "./db.ts";

export type NoticeKind = "bought" | "refunded" | "refund_failed" | "not_found" | "question";

export interface Notice {
  id: string;
  kind: NoticeKind;
  text: string;
  href: string | null;
  createdAt: Date;
  read: boolean;
}

/** Saves one notice. The same thing is never told twice: the key says which thing it is. */
export async function notify(pool: Pick<Pool, "query">, input: { userId: string; kind: NoticeKind; text: string; href?: string; key: string }): Promise<void> {
  await pool.query(
    "insert into notifications (user_id, kind, text, href, dedupe_key) values ($1, $2, $3, $4, $5) on conflict (user_id, dedupe_key) do nothing",
    [input.userId, input.kind, input.text, input.href ?? null, input.key],
  );
}

export async function listNotices(pool: Pool, userId: string, limit = 50): Promise<{ items: Notice[]; unread: number }> {
  const [rows, count] = await Promise.all([
    pool.query("select id, kind, text, href, created_at, read_at from notifications where user_id = $1 order by created_at desc, id desc limit $2", [userId, limit]),
    pool.query<{ n: number }>("select count(*)::int as n from notifications where user_id = $1 and read_at is null", [userId]),
  ]);
  return {
    items: rows.rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, href: r.href, createdAt: r.created_at, read: r.read_at !== null })),
    unread: count.rows[0]!.n,
  };
}

export async function markAllRead(pool: Pool, userId: string): Promise<void> {
  await pool.query("update notifications set read_at = now() where user_id = $1 and read_at is null", [userId]);
}
