import pg from "pg";
import { readdir, readFile } from "node:fs/promises";

export type Pool = pg.Pool;
/** Anything that can run a query: a pool, or one client inside a transaction. */
export type Queryable = Pick<pg.Pool, "query">;

const MIGRATIONS_DIR = new URL("../../db/migrations/", import.meta.url);

/** Optional schema is used by tests so every run gets its own empty set of tables. */
export function createPool(connectionString: string, schema?: string): Pool {
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error("Schema names may only use lowercase letters, digits and underscores.");
  }
  return new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10_000,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
}

/**
 * Waits until the database answers. On a host that creates the database and the services together (Render does),
 * a service can start a minute or two before the database is ready, and must not give up on the first refusal.
 * Gives up with a plain message after timeoutMs (3 minutes by default), so a database that is truly down still fails loudly.
 */
export async function waitForDatabase(
  pool: Pick<pg.Pool, "query">,
  opts: { timeoutMs?: number; intervalMs?: number; log?: (message: string) => void } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const started = Date.now();
  let lastTold = -Infinity;
  for (;;) {
    try {
      await pool.query("select 1");
      if (lastTold > -Infinity) opts.log?.(`The database is ready (after ${Math.round((Date.now() - started) / 1000)}s).`);
      return;
    } catch (err) {
      const waited = Date.now() - started;
      const why = err instanceof Error ? err.message : String(err);
      if (waited >= timeoutMs) throw new Error(`The database did not answer within ${Math.round(timeoutMs / 1000)} seconds. Last error: ${why}`);
      if (waited - lastTold >= 10_000) {
        opts.log?.(`Waiting for the database (${Math.round(waited / 1000)}s so far): ${why}`);
        lastTold = waited;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(1, timeoutMs - waited))));
    }
  }
}

/** Runs every new .sql file in db/migrations, in name order, each in its own transaction. */
export async function migrate(pool: Pool): Promise<string[]> {
  // Several services (the app and each shop) start together and all run migrations, so take a lock:
  // one runs them while the others wait, then find nothing left to do.
  const lock = await pool.connect();
  try {
    await lock.query("select pg_advisory_lock(727001)");
    return await runMigrations(pool);
  } finally {
    await lock.query("select pg_advisory_unlock(727001)");
    lock.release();
  }
}

async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set((await pool.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), "utf8");
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name) values ($1)", [file]);
      await client.query("commit");
      applied.push(file);
    } catch (err) {
      await client.query("rollback");
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
