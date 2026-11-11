// Tests of the abuse limits. The first group needs no database. The second uses a real Postgres, each run
// in its own empty schema. The model is scripted, so none of this costs any money.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { costMicroUsd, priceFor, worstCaseMicroUsd } from "../agent/pricing.ts";
import type { ModelPort } from "../agent/shopper.ts";
import { createPool, migrate } from "./db.ts";
import type { Pool } from "./db.ts";
import { FakePayPal } from "./fake-paypal.ts";
import { guardedApproveAndBuy, guardedProposeAndBuy } from "./guarded.ts";
import { DEFAULT_LIMITS, LimitError, admit, limitsFromEnv, pruneAdmissions, settle } from "./limits.ts";
import type { Limits } from "./limits.ts";
import { createMandate } from "./mandates.ts";
import { clientIp, ipBucket } from "./net.ts";

// ---------- who is calling (no database) ----------

test("addresses are counted by network: IPv4 as is, IPv6 as its whole /64, garbage together", () => {
  assert.equal(ipBucket("203.0.113.5"), "203.0.113.5");
  assert.equal(ipBucket("203.0.113.5:51234"), "203.0.113.5");
  assert.equal(ipBucket("::ffff:203.0.113.9"), "203.0.113.9");
  const a = ipBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
  assert.equal(a, "2001:0db8:0001:0002::/64");
  assert.equal(ipBucket("2001:db8:1:2::1"), a, "one person has a whole /64, so it is one bucket");
  assert.equal(ipBucket("[2001:db8:1:2::7]:443"), a);
  assert.equal(ipBucket("2001:DB8:1:2:0:0:0:9"), a);
  assert.notEqual(ipBucket("2001:db8:1:3::1"), a);
  assert.equal(ipBucket("fe80::1%eth0"), "fe80:0000:0000:0000::/64");
  for (const bad of ["", null, undefined, "not an ip", "999.1.1.1", "1.2.3", "2001:db8::1::2", "<script>"]) {
    assert.equal(ipBucket(bad as string | null | undefined), "unknown", String(bad));
  }
});

test("the forwarded-for header is ignored unless we are told how many proxies we sit behind", () => {
  const spoof = "6.6.6.6, 7.7.7.7";
  assert.equal(clientIp({ xForwardedFor: spoof, remoteAddress: "10.0.0.1", trustedHops: 0 }), "10.0.0.1", "header ignored with 0 trusted proxies");
  assert.equal(clientIp({ xForwardedFor: null, remoteAddress: "10.0.0.1", trustedHops: 1 }), "10.0.0.1");
  assert.equal(clientIp({ xForwardedFor: "", remoteAddress: "10.0.0.1", trustedHops: 1 }), "10.0.0.1");
});

test("behind one proxy, only the entry the proxy added counts, so a caller cannot invent an address", () => {
  // The caller sent "6.6.6.6, 7.7.7.7"; our proxy appended the real address.
  assert.equal(clientIp({ xForwardedFor: "6.6.6.6, 7.7.7.7, 203.0.113.5", remoteAddress: "10.0.0.1", trustedHops: 1 }), "203.0.113.5");
  assert.equal(clientIp({ xForwardedFor: "203.0.113.5", remoteAddress: "10.0.0.1", trustedHops: 1 }), "203.0.113.5");
  // Two proxies in front: take the entry the outer proxy added.
  assert.equal(clientIp({ xForwardedFor: "6.6.6.6, 203.0.113.5, 10.1.1.1", remoteAddress: "10.0.0.1", trustedHops: 2 }), "203.0.113.5");
  // Fewer entries than proxies we expected: do not guess, use the connection itself.
  assert.equal(clientIp({ xForwardedFor: "203.0.113.5", remoteAddress: "10.0.0.1", trustedHops: 2 }), "10.0.0.1");
  assert.equal(clientIp({ xForwardedFor: null, remoteAddress: null, trustedHops: 1 }), "unknown");
  assert.equal(ipBucket(clientIp({ xForwardedFor: "x, <b>, 203.0.113.5", remoteAddress: "10.0.0.1", trustedHops: 1 })), "203.0.113.5");
});

// ---------- settings (no database) ----------

test("the settings have safe defaults, and the defaults match what the owner asked for", () => {
  assert.deepEqual(limitsFromEnv({}), DEFAULT_LIMITS);
  assert.equal(DEFAULT_LIMITS.ipRunsPerDay, 10);
  assert.equal(DEFAULT_LIMITS.enabled, true);
  assert.equal(DEFAULT_LIMITS.trustedProxyHops, 0, "does not trust the header until told to");
  assert.deepEqual(limitsFromEnv({ LIMIT_IP_RUNS_PER_DAY: "", AGENT_RUNS_ENABLED: "" }), DEFAULT_LIMITS, "empty means default");
});

test("settings can be changed, and a typo stops the app instead of silently removing a limit", () => {
  const l = limitsFromEnv({
    LIMIT_IP_RUNS_PER_DAY: "3", LIMIT_USER_RUNS_PER_DAY: "7", LIMIT_IP_PURCHASES_PER_DAY: "2", LIMIT_IP_SIGNUPS_PER_DAY: "4", LIMIT_IP_CONNECTS_PER_DAY: "6", LIMIT_MAX_CONCURRENT: "2",
    LIMIT_GLOBAL_RUNS_PER_DAY: "50", LIMIT_DAILY_BUDGET_USD: "1.50", LIMIT_RUN_TOKEN_CAP: "100000", LIMIT_RUN_SECONDS: "90", TRUSTED_PROXY_HOPS: "1", AGENT_RUNS_ENABLED: "TRUE",
  });
  assert.deepEqual(l, { enabled: true, ipRunsPerDay: 3, userRunsPerDay: 7, ipPurchasesPerDay: 2, ipSignupsPerDay: 4, ipConnectsPerDay: 6, maxConcurrent: 2, globalRunsPerDay: 50, dailyBudgetUsd: 1.5, runTokenCap: 100000, runDeadlineSeconds: 90, trustedProxyHops: 1 });
  assert.equal(limitsFromEnv({ AGENT_RUNS_ENABLED: "false" }).enabled, false);
  assert.equal(limitsFromEnv({ AGENT_RUNS_ENABLED: "0" }).enabled, false);
  assert.equal(limitsFromEnv({ TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops, 0);
  for (const [name, value] of [
    ["LIMIT_IP_RUNS_PER_DAY", "ten"], ["LIMIT_IP_RUNS_PER_DAY", "0"], ["LIMIT_IP_RUNS_PER_DAY", "-1"], ["LIMIT_IP_RUNS_PER_DAY", "1.5"],
    ["LIMIT_GLOBAL_RUNS_PER_DAY", "0"], ["LIMIT_IP_SIGNUPS_PER_DAY", "0"], ["LIMIT_IP_CONNECTS_PER_DAY", "0"], ["LIMIT_RUN_TOKEN_CAP", "5"], ["LIMIT_RUN_SECONDS", "3"], ["TRUSTED_PROXY_HOPS", "-1"], ["LIMIT_MAX_CONCURRENT", "0"],
    ["LIMIT_DAILY_BUDGET_USD", "abc"], ["LIMIT_DAILY_BUDGET_USD", "0"], ["LIMIT_DAILY_BUDGET_USD", "-2"], ["AGENT_RUNS_ENABLED", "maybe"],
  ] as const) {
    assert.throws(() => limitsFromEnv({ [name]: value }), (err: unknown) => err instanceof Error && err.message.includes(name), `${name}=${value}`);
  }
});

test("run costs: Haiku is cheap, an unknown model is priced cautiously, and the worst case uses the dearer rate", () => {
  assert.equal(costMicroUsd("claude-haiku-5-5", { inputTokens: 1000, outputTokens: 200 }), 200);
  assert.equal(costMicroUsd("claude-opus-5-5", { inputTokens: 1000, outputTokens: 200 }), 8000);
  assert.deepEqual(priceFor("some-new-model"), { input: 10, output: 50 });
  assert.equal(costMicroUsd("some-new-model", { inputTokens: 100, outputTokens: 10 }), 1500);
  assert.equal(worstCaseMicroUsd("claude-haiku-5-5", 250_000), 125_000);
  assert.ok(worstCaseMicroUsd("claude-opus-5-5", 250_000) > worstCaseMicroUsd("claude-haiku-5-5", 250_000) * 30);
});

// ---------- the limits themselves (real Postgres) ----------

const url = process.env.DATABASE_URL;
const skip = url ? false : "DATABASE_URL is not set (run: docker start agent-shopper-db, then npm test)";
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
beforeEach(async () => {
  if (url) await pool.query("truncate admissions");
});
after(async () => {
  if (!url) return;
  await pool.end();
  await admin!.query(`drop schema ${schema} cascade`);
  await admin!.end();
});

const limits = (over: Partial<Limits> = {}): Limits => ({ ...DEFAULT_LIMITS, ...over });
async function newUser(): Promise<string> {
  const u = await pool.query<{ id: string }>("insert into users (email) values ($1) returning id", [`${randomBytes(4).toString("hex")}@example.com`]);
  return u.rows[0]!.id;
}
const run = (l: Limits, ip: string, userId: string, reserveMicroUsd = 0) => admit(pool, l, { kind: "agent_run", ip, userId, reserveMicroUsd });
const buy = (l: Limits, ip: string, userId: string) => admit(pool, l, { kind: "purchase", ip, userId, reserveMicroUsd: 0 });
const refusedWith = (code: string) => (err: unknown) => err instanceof LimitError && err.code === code;
const count = async (where = "true") => (await pool.query(`select count(*)::int as n from admissions where ${where}`)).rows[0].n as number;
const backdate = (kind: string, ip: string, userId: string, hours: number, settled = true) =>
  pool.query("insert into admissions (kind, ip_key, user_id, at, settled) values ($1, $2, $3, now() - make_interval(hours => $4), $5)", [kind, ip, userId, hours, settled]);

test("an address can start 10 runs a day, and the 11th is refused with a plain message", { skip }, async () => {
  const l = limits({ maxConcurrent: 100 });
  const user = await newUser();
  for (let i = 0; i < 10; i++) await run(l, "203.0.113.5", user);
  await assert.rejects(run(l, "203.0.113.5", user), (err: unknown) => {
    assert.ok(err instanceof LimitError);
    assert.equal(err.code, "ip_runs");
    assert.match(err.message, /limit of 10 runs in 24 hours from this network\. Try again in about 24 hours\./);
    assert.ok(err.retryAfterSeconds !== null && err.retryAfterSeconds > 86_000 && err.retryAfterSeconds <= 86_400);
    return true;
  });
  assert.equal(await count(), 10, "a refused run leaves no trace that counts against anyone");
  await run(l, "203.0.113.6", user);
  await assert.rejects(run(l, "203.0.113.5", await newUser()), refusedWith("ip_runs"), "a different account on the same address is still refused");
});

test("the limit is a rolling 24 hours, not a calendar day", { skip }, async () => {
  const l = limits({ maxConcurrent: 100 });
  const user = await newUser();
  for (let i = 0; i < 10; i++) await backdate("agent_run", "198.51.100.1", user, 25);
  await run(l, "198.51.100.1", user);
  for (let i = 0; i < 9; i++) await backdate("agent_run", "198.51.100.2", user, 23);
  await run(l, "198.51.100.2", user);
  await assert.rejects(run(l, "198.51.100.2", user), (err: unknown) => {
    assert.ok(err instanceof LimitError && err.code === "ip_runs");
    assert.ok(err.retryAfterSeconds !== null && err.retryAfterSeconds > 3000 && err.retryAfterSeconds < 3700, `retry in ${err.retryAfterSeconds}s`);
    assert.match(err.message, /Try again in about \d+ minutes\./);
    return true;
  });
});

test("an IPv6 visitor cannot dodge the limit by changing the last part of their address", { skip }, async () => {
  const l = limits({ ipRunsPerDay: 2, maxConcurrent: 100 });
  const user = await newUser();
  await run(l, "2001:db8:1:2::1", user);
  await run(l, "2001:db8:1:2:ffff:ffff:ffff:ffff", user);
  await assert.rejects(run(l, "2001:db8:1:2:1234::9", user), refusedWith("ip_runs"));
  await run(l, "2001:db8:1:3::1", user);
});

test("changing address does not help: each account has its own daily limit too", { skip }, async () => {
  const l = limits({ userRunsPerDay: 3, maxConcurrent: 100 });
  const user = await newUser();
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) await run(l, ip, user);
  await assert.rejects(run(l, "192.0.2.4", user), (err: unknown) => err instanceof LimitError && err.code === "user_runs" && /This account has reached its limit of 3 runs/.test(err.message));
  await run(l, "192.0.2.4", await newUser());
});

test("only one run at a time per address and per account, and a crashed run stops blocking after ten minutes", { skip }, async () => {
  const l = limits();
  const userA = await newUser();
  const userB = await newUser();
  const first = await run(l, "192.0.2.10", userA);
  await assert.rejects(run(l, "192.0.2.10", userB), refusedWith("busy"), "same address");
  await assert.rejects(run(l, "192.0.2.11", userA), refusedWith("busy"), "same account, new address");
  const other = await run(l, "192.0.2.12", userB);
  await settle(pool, first.id, 0);
  await run(l, "192.0.2.11", userA);
  await settle(pool, other.id, 0);

  const userC = await newUser();
  await pool.query("insert into admissions (kind, ip_key, user_id, at, settled) values ('agent_run', '192.0.2.20', $1, now() - interval '11 minutes', false)", [userC]);
  await run(l, "192.0.2.20", userC);
  await assert.rejects(run(l, "192.0.2.20", userC), refusedWith("busy"));
});

test("25 requests at the same instant from one address let exactly 10 through", { skip }, async () => {
  const l = limits({ maxConcurrent: 100, userRunsPerDay: 100 });
  const user = await newUser();
  const results = await Promise.allSettled(Array.from({ length: 25 }, () => run(l, "203.0.113.50", user)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 10);
  const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  assert.equal(refused.length, 15);
  assert.ok(refused.every((r) => r.reason instanceof LimitError && r.reason.code === "ip_runs"));
  assert.equal(await count("ip_key = '203.0.113.50'"), 10);
});

test("a burst at the same instant also cannot exceed the one-at-a-time rule", { skip }, async () => {
  const l = limits();
  const user = await newUser();
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => run(l, "203.0.113.60", user)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("the whole demo has a daily cap, however many addresses are used", { skip }, async () => {
  const l = limits({ globalRunsPerDay: 3, maxConcurrent: 100 });
  for (let i = 1; i <= 3; i++) await run(l, `192.0.2.${100 + i}`, await newUser());
  await assert.rejects(run(l, "192.0.2.200", await newUser()), (err: unknown) => err instanceof LimitError && err.code === "global_runs" && /Try again tomorrow/.test(err.message));
});

test("a daily money budget stops runs before they start, and a crashed run keeps its reservation", { skip }, async () => {
  const l = limits({ dailyBudgetUsd: 0.3, maxConcurrent: 100 });
  const reserve = 125_000; // $0.125, the worst case of one Haiku run at the default token cap
  const a = await run(l, "192.0.2.31", await newUser(), reserve);
  const b = await run(l, "192.0.2.32", await newUser(), reserve);
  await assert.rejects(run(l, "192.0.2.33", await newUser(), reserve), (err: unknown) => err instanceof LimitError && err.code === "budget" && /budget has been used up/.test(err.message));

  await settle(pool, a.id, 200);
  await run(l, "192.0.2.33", await newUser(), reserve);
  await assert.rejects(run(l, "192.0.2.34", await newUser(), reserve), refusedWith("budget"), "the third run's reservation uses the room again");

  await settle(pool, b.id, null);
  const left = await pool.query("select reserved_micro_usd, actual_micro_usd, settled from admissions where id = $1", [b.id]);
  assert.equal(Number(left.rows[0].reserved_micro_usd), reserve, "an unknown cost keeps the full reservation counted");
  assert.equal(left.rows[0].actual_micro_usd, null);
  assert.equal(left.rows[0].settled, true);
});

test("the off switch refuses every new run and purchase and records nothing", { skip }, async () => {
  const off = limits({ enabled: false });
  const user = await newUser();
  await assert.rejects(run(off, "192.0.2.40", user), (err: unknown) => err instanceof LimitError && err.code === "disabled" && /paused right now/.test(err.message));
  await assert.rejects(buy(off, "192.0.2.40", user), refusedWith("disabled"));
  assert.equal(await count(), 0);
  await run(limits(), "192.0.2.40", user);
});

test("purchases have their own daily limit per address, separate from runs", { skip }, async () => {
  const l = limits({ ipPurchasesPerDay: 2, ipRunsPerDay: 2, maxConcurrent: 100 });
  const user = await newUser();
  await buy(l, "192.0.2.50", user);
  await buy(l, "192.0.2.50", user);
  await assert.rejects(buy(l, "192.0.2.50", user), (err: unknown) => err instanceof LimitError && err.code === "ip_purchases" && /limit of 2 purchases/.test(err.message));
  await run(l, "192.0.2.50", user);
  await run(l, "192.0.2.50", user);
  await assert.rejects(run(l, "192.0.2.50", user), refusedWith("ip_runs"));
  await buy(l, "192.0.2.51", user);
});

test("creating demo accounts is limited per address, before the account exists", { skip }, async () => {
  const l = limits({ ipSignupsPerDay: 2 });
  const signup = (ip: string) => admit(pool, l, { kind: "signup", ip, userId: null, reserveMicroUsd: 0 });
  await signup("192.0.2.80");
  await signup("192.0.2.80");
  await assert.rejects(signup("192.0.2.80"), (err: unknown) => err instanceof LimitError && err.code === "ip_signups" && /limit of 2 demo accounts/.test(err.message));
  await signup("192.0.2.81");
  await run(limits({ maxConcurrent: 100 }), "192.0.2.80", await newUser());
  await assert.rejects(admit(pool, limits({ enabled: false }), { kind: "signup", ip: "192.0.2.82", userId: null, reserveMicroUsd: 0 }), refusedWith("disabled"));
  await assert.rejects(admit(pool, l, { kind: "agent_run", ip: "192.0.2.83", userId: null, reserveMicroUsd: 0 }), /needs an account/);
});

test("connecting a PayPal account is limited per address", { skip }, async () => {
  const l = limits({ ipConnectsPerDay: 2 });
  const user = await newUser();
  const connect = (ip: string) => admit(pool, l, { kind: "connect", ip, userId: user, reserveMicroUsd: 0 });
  await connect("192.0.2.90");
  await connect("192.0.2.90");
  await assert.rejects(connect("192.0.2.90"), (err: unknown) => err instanceof LimitError && err.code === "ip_connects" && /limit of 2 PayPal connections/.test(err.message));
  await connect("192.0.2.91");
  await run(limits({ maxConcurrent: 100 }), "192.0.2.90", user);
});

test("old records can be deleted, but never ones inside the 24-hour window", { skip }, async () => {
  const user = await newUser();
  await backdate("agent_run", "192.0.2.60", user, 1);
  await backdate("agent_run", "192.0.2.60", user, 24 * 3);
  await backdate("agent_run", "192.0.2.60", user, 24 * 10);
  assert.equal(await pruneAdmissions(pool, 7), 1);
  assert.equal(await count(), 2);
  assert.equal(await pruneAdmissions(pool, 0), 1, "asking to keep nothing still keeps two days");
  assert.equal(await count(), 1);
});

test("refusal messages are plain and never expose how the limits are built", { skip }, async () => {
  const user = await newUser();
  const messages: string[] = [];
  const grab = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      messages.push((err as Error).message);
    }
  };
  await grab(run(limits({ enabled: false }), "192.0.2.70", user));
  await run(limits({ ipRunsPerDay: 1 }), "192.0.2.70", user);
  await grab(run(limits({ ipRunsPerDay: 1 }), "192.0.2.70", user));
  await grab(run(limits({ userRunsPerDay: 1, maxConcurrent: 9 }), "192.0.2.71", user));
  await grab(run(limits({ globalRunsPerDay: 1, maxConcurrent: 9 }), "192.0.2.72", await newUser()));
  await grab(run(limits({ dailyBudgetUsd: 0.001, maxConcurrent: 9 }), "192.0.2.73", await newUser(), 5_000_000));
  await grab(buy(limits({ ipPurchasesPerDay: 1 }), "192.0.2.74", user).then(() => buy(limits({ ipPurchasesPerDay: 1 }), "192.0.2.74", user)));
  assert.equal(messages.length, 6);
  for (const m of messages) {
    assert.doesNotMatch(m, /admissions|advisory|ip_key|sql|bucket|postgres|at \//i, m);
    assert.match(m, /\.$/, "ends like a sentence");
  }
});

// ---------- the entry points a public server must use (scripted model, no cost) ----------

type Params = Anthropic.MessageCreateParamsNonStreaming;
function reply(content: Array<Record<string, unknown>>, usage = { input_tokens: 1000, output_tokens: 200 }, stop_reason = "end_turn"): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason, stop_sequence: null, usage } as unknown as Anthropic.Message;
}
const giveUp = () => reply([{ type: "tool_use", id: "g", name: "give_up", input: { reason: "Nothing fits." } }], undefined, "tool_use");

function guarded(model: ModelPort, over: Partial<Limits> = {}) {
  const fetched: string[] = [];
  return {
    fetched,
    deps: {
      paypal: new FakePayPal(),
      model,
      fetchPage: async (u: string) => {
        fetched.push(u);
        throw new Error("no network in this test");
      },
      now: () => new Date("2026-11-11T12:00:00Z"),
      minSearches: 0,
      limits: limits(over),
    },
  };
}
async function world() {
  const userId = await newUser();
  await pool.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, 50000)", [userId]);
  const { mandateId } = await createMandate(pool, {
    userId, item: "Wireless earbuds", condition: "new", maxPriceCents: 10000, askAboveCents: 10000, deadline: "2027-03-01",
    sellerMinScore: 70, neverBuy: [], setAsideCents: 10000,
  });
  return { userId, mandateId, shops: [{ id: "northgear", baseUrl: "http://northgear.localhost:4101" }] };
}
const counting = (make: () => Anthropic.Message): ModelPort & { calls: number } => {
  const m = (async (_p: Params) => {
    m.calls++;
    return make();
  }) as ModelPort & { calls: number };
  m.calls = 0;
  return m;
};

test("through the public entry point, the 11th run from an address never reaches the model", { skip }, async () => {
  const w = await world();
  const model = counting(giveUp);
  const g = guarded(model);
  for (let i = 0; i < 10; i++) assert.equal((await guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.5" })).stage, "agent");
  assert.equal(model.calls, 10);
  await assert.rejects(guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.5" }), refusedWith("ip_runs"));
  assert.equal(model.calls, 10, "refused before the model was called, so it cost nothing");
  await guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.6" });
  assert.equal(model.calls, 11);
  const rows = await pool.query("select actual_micro_usd, settled from admissions where kind = 'agent_run'");
  assert.equal(rows.rowCount, 11);
  assert.ok(rows.rows.every((r) => r.settled === true && Number(r.actual_micro_usd) === 200), "each run settled at its real Haiku cost");
});

test("a run that crashes is settled, keeps its reservation, and does not block the next one", { skip }, async () => {
  const w = await world();
  const boom: ModelPort = async () => {
    throw new Error("the model is down");
  };
  const g = guarded(boom);
  await assert.rejects(guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.9" }), /the model is down/);
  const row = (await pool.query("select settled, actual_micro_usd, reserved_micro_usd from admissions")).rows[0];
  assert.equal(row.settled, true);
  assert.equal(row.actual_micro_usd, null);
  assert.equal(Number(row.reserved_micro_usd), 125_000);
  const ok = guarded(counting(giveUp));
  assert.equal((await guardedProposeAndBuy(pool, ok.deps, { ...w, ip: "203.0.113.9" })).stage, "agent");
});

test("a run that uses too many tokens is stopped before it can act, and the cost is recorded", { skip }, async () => {
  const w = await world();
  const greedy = counting(() => reply([{ type: "tool_use", id: "o", name: "open_page", input: { url: "http://northgear.localhost:4101/" } }], { input_tokens: 300_000, output_tokens: 200 }, "tool_use"));
  const g = guarded(greedy);
  const r = await guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.20" });
  assert.equal(r.stage, "agent");
  assert.deepEqual(r.stage === "agent" && r.outcome, { status: "token_limit" });
  assert.equal(greedy.calls, 1);
  assert.deepEqual(g.fetched, [], "the page it asked for was never opened");
  const row = (await pool.query("select actual_micro_usd from admissions")).rows[0];
  assert.equal(Number(row.actual_micro_usd), 300_000 * 0.1 + 200 * 0.5);
});

test("approving purchases counts against the caller's purchase limit", { skip }, async () => {
  const w = await world();
  const g = guarded(counting(giveUp), { ipPurchasesPerDay: 2 });
  const approve = () => guardedApproveAndBuy(pool, g.deps, { userId: w.userId, mandateId: w.mandateId, proposalId: "nope", approvedTotalCents: 4500, ip: "203.0.113.30" });
  await assert.rejects(approve(), /Proposal not found/);
  await assert.rejects(approve(), /Proposal not found/);
  await assert.rejects(approve(), refusedWith("ip_purchases"));
  assert.equal(await count("kind = 'purchase' and settled = true"), 2);
});

test("with the off switch on, the public entry points do nothing", { skip }, async () => {
  const w = await world();
  const model = counting(giveUp);
  const g = guarded(model, { enabled: false });
  await assert.rejects(guardedProposeAndBuy(pool, g.deps, { ...w, ip: "203.0.113.40" }), refusedWith("disabled"));
  await assert.rejects(guardedApproveAndBuy(pool, g.deps, { userId: w.userId, mandateId: w.mandateId, proposalId: "x", approvedTotalCents: 1, ip: "203.0.113.40" }), refusedWith("disabled"));
  assert.equal(model.calls, 0);
  assert.equal(await count(), 0);
});

test("on Render the header is the visitor then a Cloudflare address, so two trusted proxies finds the visitor", () => {
  // Measured on the deployed app (scripts/cloud-check.ts): "<visitor>, <Cloudflare edge>".
  const seen = "203.0.113.45, 172.71.150.57";
  assert.equal(clientIp({ xForwardedFor: seen, remoteAddress: "10.230.1.1", trustedHops: 2 }), "203.0.113.45", "two proxies: the visitor");
  assert.equal(clientIp({ xForwardedFor: seen, remoteAddress: "10.230.1.1", trustedHops: 1 }), "172.71.150.57", "one proxy would count every visitor as the Cloudflare address");
  // A visitor cannot pick their own address by sending the header themselves: whatever they send comes before the real one.
  const forged = "9.9.9.9, 8.8.8.8, 203.0.113.45, 172.71.150.57";
  assert.equal(clientIp({ xForwardedFor: forged, remoteAddress: "10.230.1.1", trustedHops: 2 }), "203.0.113.45");
  assert.equal(ipBucket(clientIp({ xForwardedFor: "2001:db8:abcd:12:aaaa:bbbb:cccc:dddd, 172.71.150.57", remoteAddress: "10.0.0.1", trustedHops: 2 })), "2001:0db8:abcd:0012::/64", "an IPv6 visitor is counted by their /64");
  // If the header is shorter than expected, fall back to the connection itself, never to a made-up value.
  assert.equal(clientIp({ xForwardedFor: "172.71.150.57", remoteAddress: "10.230.1.1", trustedHops: 2 }), "10.230.1.1");
});

test("the run deadline is 2 minutes by default, can be set, and cannot be set too small to be useful", () => {
  assert.equal(DEFAULT_LIMITS.runDeadlineSeconds, 120);
  assert.equal(limitsFromEnv({ LIMIT_RUN_SECONDS: "45" }).runDeadlineSeconds, 45);
  assert.equal(limitsFromEnv({ LIMIT_RUN_SECONDS: "" }).runDeadlineSeconds, 120, "empty means the default");
  for (const bad of ["5", "9", "abc", "-1", "1.5", "0"]) {
    assert.throws(() => limitsFromEnv({ LIMIT_RUN_SECONDS: bad }), /LIMIT_RUN_SECONDS must be a whole number of at least 10/, bad);
  }
});

