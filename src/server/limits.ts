// Abuse limits for a public deployment. Every agent run costs real money (the model) and every purchase
// moves money, so each one has to be admitted here first. Limits are counted in the database, over a
// rolling 24 hours, so they hold across restarts and across several services.
//
// Defaults suit a hackathon demo. Change them with the LIMIT_* settings, not in code.

import type { Pool } from "./db.ts";
import { ipBucket } from "./net.ts";

export interface Limits {
  /** The off switch. false refuses every new run and purchase. */
  enabled: boolean;
  ipRunsPerDay: number;
  userRunsPerDay: number;
  ipPurchasesPerDay: number;
  /** How many demo accounts one address may create. */
  ipSignupsPerDay: number;
  /** How many times one address may start connecting a PayPal account. */
  ipConnectsPerDay: number;
  /** How many runs one address, or one account, may have going at once. */
  maxConcurrent: number;
  globalRunsPerDay: number;
  /** The most the model may cost across everyone in 24 hours, in US dollars. */
  dailyBudgetUsd: number;
  /** The most tokens one run may use before it is stopped. */
  runTokenCap: number;
  /** Most seconds one shopper run may take before it stops with what it has. */
  runDeadlineSeconds: number;
  /** How many proxies sit in front of the app. See net.ts. */
  trustedProxyHops: number;
}

export const DEFAULT_LIMITS: Limits = {
  enabled: true,
  ipRunsPerDay: 10,
  userRunsPerDay: 20,
  ipPurchasesPerDay: 5,
  ipSignupsPerDay: 5,
  ipConnectsPerDay: 10,
  maxConcurrent: 1,
  globalRunsPerDay: 300,
  dailyBudgetUsd: 5,
  runTokenCap: 250_000,
  runDeadlineSeconds: 120,
  trustedProxyHops: 0,
};

function wholeNumber(env: Record<string, string | undefined>, name: string, fallback: number, min: number): number {
  const v = env[name]?.trim();
  if (v === undefined || v === "") return fallback;
  if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be a whole number of at least ${min}, but it is "${v}".`);
  return Number(v);
}

/** Reads the settings. A wrong value stops the app at startup, so a typo never quietly removes a limit. */
export function limitsFromEnv(env: Record<string, string | undefined> = process.env): Limits {
  const d = DEFAULT_LIMITS;
  const budget = env["LIMIT_DAILY_BUDGET_USD"]?.trim();
  if (budget !== undefined && budget !== "" && (!/^\d+(\.\d+)?$/.test(budget) || Number(budget) <= 0)) {
    throw new Error(`LIMIT_DAILY_BUDGET_USD must be a positive number of dollars, but it is "${budget}".`);
  }
  const switchValue = env["AGENT_RUNS_ENABLED"]?.trim().toLowerCase();
  if (switchValue !== undefined && switchValue !== "" && !["true", "false", "1", "0"].includes(switchValue)) {
    throw new Error(`AGENT_RUNS_ENABLED must be true or false, but it is "${switchValue}".`);
  }
  return {
    enabled: switchValue === undefined || switchValue === "" ? d.enabled : switchValue === "true" || switchValue === "1",
    ipRunsPerDay: wholeNumber(env, "LIMIT_IP_RUNS_PER_DAY", d.ipRunsPerDay, 1),
    userRunsPerDay: wholeNumber(env, "LIMIT_USER_RUNS_PER_DAY", d.userRunsPerDay, 1),
    ipPurchasesPerDay: wholeNumber(env, "LIMIT_IP_PURCHASES_PER_DAY", d.ipPurchasesPerDay, 1),
    ipSignupsPerDay: wholeNumber(env, "LIMIT_IP_SIGNUPS_PER_DAY", d.ipSignupsPerDay, 1),
    ipConnectsPerDay: wholeNumber(env, "LIMIT_IP_CONNECTS_PER_DAY", d.ipConnectsPerDay, 1),
    maxConcurrent: wholeNumber(env, "LIMIT_MAX_CONCURRENT", d.maxConcurrent, 1),
    globalRunsPerDay: wholeNumber(env, "LIMIT_GLOBAL_RUNS_PER_DAY", d.globalRunsPerDay, 1),
    dailyBudgetUsd: budget === undefined || budget === "" ? d.dailyBudgetUsd : Number(budget),
    runTokenCap: wholeNumber(env, "LIMIT_RUN_TOKEN_CAP", d.runTokenCap, 1000),
    runDeadlineSeconds: wholeNumber(env, "LIMIT_RUN_SECONDS", d.runDeadlineSeconds, 10),
    trustedProxyHops: wholeNumber(env, "TRUSTED_PROXY_HOPS", d.trustedProxyHops, 0),
  };
}

export type LimitCode = "disabled" | "ip_runs" | "user_runs" | "ip_purchases" | "ip_signups" | "ip_connects" | "busy" | "global_runs" | "budget";

export class LimitError extends Error {
  code: LimitCode;
  /** Seconds until trying again can work, when that is known. */
  retryAfterSeconds: number | null;
  constructor(code: LimitCode, message: string, retryAfterSeconds: number | null) {
    super(message);
    this.name = "LimitError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function wait(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 90) return " Try again in a minute.";
  if (seconds < 5400) return ` Try again in about ${Math.ceil(seconds / 60)} minutes.`;
  return ` Try again in about ${Math.ceil(seconds / 3600)} hours.`;
}

// A run that never reports back (a crash) stops counting as "in progress" after this long.
const STALE_RUN_SECONDS = 600;
const ADMISSION_LOCK = 727002;

export interface AdmitRequest {
  kind: "agent_run" | "purchase" | "signup" | "connect";
  /** The caller's address, already worked out with clientIp(). */
  ip: string | null | undefined;
  /** Null for a signup, because the account does not exist yet. */
  userId: string | null;
  /** Worst-case cost to set aside, in millionths of a dollar. */
  reserveMicroUsd: number;
}

/**
 * Lets one run or purchase start, or refuses it with a LimitError saying why. The checks and the
 * recording happen under one lock, so a burst of simultaneous requests cannot slip past a limit together.
 */
export async function admit(pool: Pool, limits: Limits, req: AdmitRequest): Promise<{ id: number }> {
  const ipKey = ipBucket(req.ip);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1)", [ADMISSION_LOCK]);
    if (!limits.enabled) throw new LimitError("disabled", "New runs are paused right now.", null);

    const used = async (where: string, params: unknown[]): Promise<{ n: number; retry: number | null }> => {
      const r = await client.query<{ n: number; retry: number | null }>(
        `select count(*)::int as n, ceil(extract(epoch from (min(at) + interval '24 hours' - now())))::int as retry
         from admissions where ${where} and at > now() - interval '24 hours'`,
        params,
      );
      return r.rows[0]!;
    };

    if (req.kind === "connect") {
      const c = await used("kind = 'connect' and ip_key = $1", [ipKey]);
      if (c.n >= limits.ipConnectsPerDay) {
        throw new LimitError("ip_connects", `You've reached the limit of ${limits.ipConnectsPerDay} PayPal connections in 24 hours from this network.${wait(c.retry)}`, c.retry);
      }
    } else if (req.kind === "signup") {
      const s = await used("kind = 'signup' and ip_key = $1", [ipKey]);
      if (s.n >= limits.ipSignupsPerDay) {
        throw new LimitError("ip_signups", `You've reached the limit of ${limits.ipSignupsPerDay} demo accounts in 24 hours from this network.${wait(s.retry)}`, s.retry);
      }
    } else if (req.kind === "purchase") {
      const p = await used("kind = 'purchase' and ip_key = $1", [ipKey]);
      if (p.n >= limits.ipPurchasesPerDay) {
        throw new LimitError("ip_purchases", `You've reached the limit of ${limits.ipPurchasesPerDay} purchases in 24 hours from this network.${wait(p.retry)}`, p.retry);
      }
    } else {
      const ip = await used("kind = 'agent_run' and ip_key = $1", [ipKey]);
      if (ip.n >= limits.ipRunsPerDay) {
        throw new LimitError("ip_runs", `You've reached the limit of ${limits.ipRunsPerDay} runs in 24 hours from this network.${wait(ip.retry)}`, ip.retry);
      }
      if (req.userId === null) throw new Error("A run needs an account.");
      const user = await used("kind = 'agent_run' and user_id = $1", [req.userId]);
      if (user.n >= limits.userRunsPerDay) {
        throw new LimitError("user_runs", `This account has reached its limit of ${limits.userRunsPerDay} runs in 24 hours.${wait(user.retry)}`, user.retry);
      }
      const busy = await client.query<{ n: number }>(
        `select count(*)::int as n from admissions
         where kind = 'agent_run' and settled = false and at > now() - make_interval(secs => $3) and (ip_key = $1 or user_id = $2)`,
        [ipKey, req.userId, STALE_RUN_SECONDS],
      );
      if (busy.rows[0]!.n >= limits.maxConcurrent) {
        throw new LimitError("busy", "A run is already in progress. Wait for it to finish, then try again.", null);
      }
      const global = await used("kind = 'agent_run'", []);
      if (global.n >= limits.globalRunsPerDay) {
        throw new LimitError("global_runs", "The demo has reached its daily limit of runs. Try again tomorrow.", global.retry);
      }
      const spent = await client.query<{ micro: string }>(
        "select coalesce(sum(coalesce(actual_micro_usd, reserved_micro_usd)), 0)::bigint as micro from admissions where at > now() - interval '24 hours'",
      );
      const budgetMicro = Math.round(limits.dailyBudgetUsd * 1_000_000);
      if (Number(spent.rows[0]!.micro) + req.reserveMicroUsd > budgetMicro) {
        throw new LimitError("budget", "The demo's daily budget has been used up. Try again tomorrow.", null);
      }
    }

    const row = await client.query<{ id: string }>(
      "insert into admissions (kind, ip_key, user_id, reserved_micro_usd) values ($1, $2, $3, $4) returning id",
      [req.kind, ipKey, req.userId, req.reserveMicroUsd],
    );
    await client.query("commit");
    return { id: Number(row.rows[0]!.id) };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/** Marks a run finished. Pass the real cost, or null if it is not known: the reservation then stays counted. */
export async function settle(pool: Pool, id: number, actualMicroUsd: number | null): Promise<void> {
  await pool.query("update admissions set settled = true, settled_at = now(), actual_micro_usd = $2 where id = $1", [id, actualMicroUsd]);
}

/** Deletes old rows. Rows inside the 24-hour window are never touched. Run it now and then. */
export async function pruneAdmissions(pool: Pool, keepDays = 7): Promise<number> {
  const days = Math.max(2, keepDays);
  const r = await pool.query("delete from admissions where at < now() - make_interval(days => $1)", [days]);
  return r.rowCount ?? 0;
}
