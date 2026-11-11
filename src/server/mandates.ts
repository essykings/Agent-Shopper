import type { GiftGoal } from "../shared/types.ts";
import type { Pool } from "./db.ts";
import { getBalances } from "./balances.ts";
import { appendLedger } from "./ledger.ts";

export interface NewMandate {
  userId: string;
  item: string;
  condition: "new" | "any";
  maxPriceCents: number;
  askAboveCents: number;
  deadline: string;
  sellerMinScore: number;
  neverBuy: string[];
  /** Set aside from the allowance. Must be at least the maximum price. */
  setAsideCents: number;
  /** A gift has no fixed item; the goal says who it is for. */
  kind?: "item" | "gift";
  goal?: GiftGoal;
}

export class InsufficientAllowanceError extends Error {
  freeCents: number;
  wantedCents: number;
  constructor(freeCents: number, wantedCents: number) {
    super(`Only $${(freeCents / 100).toFixed(2)} of your allowance is free, and this request needs $${(wantedCents / 100).toFixed(2)}.`);
    this.name = "InsufficientAllowanceError";
    this.freeCents = freeCents;
    this.wantedCents = wantedCents;
  }
}

export class AccountPausedError extends Error {
  constructor() {
    super("Your shopper is paused. Resume it to start new requests.");
    this.name = "AccountPausedError";
  }
}

/**
 * Starts a request and sets its budget aside. The account row is locked first, so two requests
 * made at the same moment can never both use the same dollars.
 */
export async function createMandate(pool: Pool, input: NewMandate, now: Date = new Date()): Promise<{ mandateId: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const account = await client.query<{ paused: boolean }>("select paused from accounts where user_id = $1 for update", [input.userId]);
    if (account.rowCount === 0) throw new Error("No account for this user.");
    if (account.rows[0]!.paused) throw new AccountPausedError();

    const balances = await getBalances(client, input.userId, now);
    if (input.setAsideCents > balances.freeCents) {
      throw new InsufficientAllowanceError(balances.freeCents, input.setAsideCents);
    }

    const inserted = await client.query<{ id: string }>(
      `insert into mandates
         (user_id, item, condition, max_price_cents, ask_above_cents, deadline, seller_min_score, never_buy, set_aside_cents, kind, goal)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [input.userId, input.item, input.condition, input.maxPriceCents, input.askAboveCents, input.deadline, input.sellerMinScore, input.neverBuy, input.setAsideCents, input.kind ?? "item", input.goal ? JSON.stringify(input.goal) : null],
    );
    const mandateId = inserted.rows[0]!.id;
    await appendLedger(client, {
      userId: input.userId,
      mandateId,
      kind: "set_aside",
      amountCents: input.setAsideCents,
      detail: { item: input.item, ...(input.kind === "gift" ? { kind: "gift" } : {}) },
    });
    await client.query("commit");
    return { mandateId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}
