// These tests use a real Postgres (see docker-compose.yml). Each run gets its own empty schema,
// which is dropped at the end. Without DATABASE_URL they are skipped.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createPool, migrate } from "./db.ts";
import type { Pool } from "./db.ts";
import { appendLedger, listLedger } from "./ledger.ts";
import { getBalances } from "./balances.ts";
import { AccountPausedError, InsufficientAllowanceError, createMandate } from "./mandates.ts";
import type { NewMandate } from "./mandates.ts";

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set (run: docker compose up -d, then npm test)";
const schema = `t_${randomBytes(6).toString("hex")}`;

let admin: Pool | undefined;
let pool: Pool;

before(async () => {
  if (!url) return;
  admin = createPool(url);
  await admin.query(`create schema ${schema}`);
  pool = createPool(url, schema);
  await migrate(pool);
});

after(async () => {
  if (!url) return;
  await pool.end();
  await admin!.query(`drop schema ${schema} cascade`);
  await admin!.end();
});

async function newUser(allowanceCents = 50000, paused = false): Promise<string> {
  const u = await pool.query<{ id: string }>("insert into users (email) values ($1) returning id", [`${randomBytes(4).toString("hex")}@example.com`]);
  const id = u.rows[0]!.id;
  await pool.query("insert into accounts (user_id, monthly_allowance_cents, paused) values ($1, $2, $3)", [id, allowanceCents, paused]);
  return id;
}

const request = (userId: string, setAsideCents: number, over: Partial<NewMandate> = {}): NewMandate => ({
  userId,
  item: "PS5 disc edition",
  condition: "new",
  maxPriceCents: setAsideCents,
  askAboveCents: Math.floor(setAsideCents * 0.8),
  deadline: "2027-03-01",
  sellerMinScore: 70,
  neverBuy: ["gift cards"],
  setAsideCents,
  ...over,
});

test("migrations run once and are safe to run again", { skip }, async () => {
  assert.deepEqual(await migrate(pool), []);
  const tables = await pool.query("select table_name from information_schema.tables where table_schema = $1", [schema]);
  const names = tables.rows.map((r) => r.table_name);
  for (const t of ["users", "accounts", "mandates", "ledger_entries", "schema_migrations"]) assert.ok(names.includes(t), t);
});

test("the ledger stores a row and returns it newest first", { skip }, async () => {
  const user = await newUser();
  await appendLedger(pool, { userId: user, kind: "note", detail: { text: "first" } });
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 3400, detail: { shop: "lumen" } });
  const rows = await listLedger(pool, user);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.kind, "payment_captured");
  assert.equal(rows[0]!.amountCents, 3400);
  assert.deepEqual(rows[1]!.detail, { text: "first" });
});

test("the same idempotency key is stored once", { skip }, async () => {
  const user = await newUser();
  const a = await appendLedger(pool, { userId: user, kind: "refund_received", amountCents: 1200, idempotencyKey: `wh-${user}` });
  const b = await appendLedger(pool, { userId: user, kind: "refund_received", amountCents: 1200, idempotencyKey: `wh-${user}` });
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  assert.equal(a.id, b.id);
  assert.equal((await listLedger(pool, user)).length, 1);
});

test("ledger rows cannot be changed, deleted or truncated", { skip }, async () => {
  const user = await newUser();
  const { id } = await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 100 });
  await assert.rejects(pool.query("update ledger_entries set amount_cents = 1 where id = $1", [id]), /cannot be changed or deleted/);
  await assert.rejects(pool.query("delete from ledger_entries where id = $1", [id]), /cannot be changed or deleted/);
  await assert.rejects(pool.query("truncate ledger_entries"), /cannot be changed or deleted/);
  assert.equal((await listLedger(pool, user))[0]!.amountCents, 100);
});

test("the ledger rejects negative or fractional amounts and unknown kinds", { skip }, async () => {
  const user = await newUser();
  await assert.rejects(appendLedger(pool, { userId: user, kind: "note", amountCents: -5 }), /whole cents/);
  await assert.rejects(appendLedger(pool, { userId: user, kind: "note", amountCents: 1.5 }), /whole cents/);
  await assert.rejects(pool.query("insert into ledger_entries (user_id, kind) values ($1, 'made_up')", [user]));
});

test("balances add up like the Home screen: $500 allowance, $120 spent, $300 set aside, $80 free", { skip }, async () => {
  const user = await newUser(50000);
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 3400 });
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 3800 });
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 4800 });
  await createMandate(pool, request(user, 30000));
  assert.deepEqual(await getBalances(pool, user), {
    monthlyAllowanceCents: 50000,
    monthSpentCents: 12000,
    setAsideCents: 30000,
    freeCents: 8000,
  });
});

test("a refund lowers what you spent this month", { skip }, async () => {
  const user = await newUser(50000);
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 3400 });
  await appendLedger(pool, { userId: user, kind: "refund_received", amountCents: 1200 });
  const b = await getBalances(pool, user);
  assert.equal(b.monthSpentCents, 2200);
  assert.equal(b.freeCents, 50000 - 2200);
});

test("spending on a request shrinks what is set aside, so free money does not change", { skip }, async () => {
  const user = await newUser(50000);
  const { mandateId } = await createMandate(pool, request(user, 30000));
  assert.equal((await getBalances(pool, user)).freeCents, 20000);
  await appendLedger(pool, { userId: user, mandateId, kind: "payment_captured", amountCents: 27900 });
  const b = await getBalances(pool, user);
  assert.equal(b.monthSpentCents, 27900);
  assert.equal(b.setAsideCents, 2100);
  assert.equal(b.freeCents, 20000);
});

test("payments from last month are not counted this month", { skip }, async () => {
  const user = await newUser(50000);
  await pool.query(
    "insert into ledger_entries (user_id, kind, amount_cents, at) values ($1, 'payment_captured', 9900, '2026-10-20T10:00:00Z')",
    [user],
  );
  assert.equal((await getBalances(pool, user, new Date("2026-11-11T12:00:00Z"))).monthSpentCents, 0);
  assert.equal((await getBalances(pool, user, new Date("2026-10-25T12:00:00Z"))).monthSpentCents, 9900);
});

test("a request is refused when not enough allowance is free", { skip }, async () => {
  const user = await newUser(50000);
  await createMandate(pool, request(user, 30000));
  await appendLedger(pool, { userId: user, kind: "payment_captured", amountCents: 12000 });
  await assert.rejects(createMandate(pool, request(user, 9000)), (err: unknown) => {
    assert.ok(err instanceof InsufficientAllowanceError);
    assert.equal(err.freeCents, 8000);
    assert.match(err.message, /\$80\.00/);
    return true;
  });
  const mandates = await pool.query("select count(*)::int as n from mandates where user_id = $1", [user]);
  assert.equal(mandates.rows[0].n, 1);
});

test("two requests made at the same moment cannot both use the same dollars", { skip }, async () => {
  const user = await newUser(50000);
  const results = await Promise.allSettled([
    createMandate(pool, request(user, 30000)),
    createMandate(pool, request(user, 30000)),
    createMandate(pool, request(user, 30000)),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 2);
  const b = await getBalances(pool, user);
  assert.equal(b.setAsideCents, 30000);
  assert.equal(b.freeCents, 20000);
  const asides = await pool.query("select count(*)::int as n from ledger_entries where user_id = $1 and kind = 'set_aside'", [user]);
  assert.equal(asides.rows[0].n, 1);
});

test("a paused shopper cannot start new requests", { skip }, async () => {
  const user = await newUser(50000, true);
  await assert.rejects(createMandate(pool, request(user, 10000)), AccountPausedError);
});

test("the database refuses a request whose set-aside is below its maximum price", { skip }, async () => {
  const user = await newUser(50000);
  await assert.rejects(createMandate(pool, request(user, 30000, { maxPriceCents: 40000, askAboveCents: 30000 })));
  assert.equal((await getBalances(pool, user)).setAsideCents, 0);
});
