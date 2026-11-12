// The web app's server API. Everything that costs money goes through the limited entry points in
// guarded.ts, so the abuse limits cannot be skipped from here.

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { parseAbout } from "../agent/pages.ts";
import type { ShopRef } from "../agent/shopper.ts";
import { scoreSeller } from "../agent/seller.ts";
import { getBalances } from "../server/balances.ts";
import type { BuyDeps } from "../server/buy.ts";
import type { Pool } from "../server/db.ts";
import { streamSSE } from "hono/streaming";
import type { SSEStreamingApi } from "hono/streaming";
import { guardedApproveAndBuy, guardedProposeAndBuy } from "../server/guarded.ts";
import { Hub } from "./hub.ts";
import { checkOrders, declineCase, draftMessage, listCases, loadCase, refundCase, saveDraft } from "../server/aftercare.ts";
import type { AftercareDeps } from "../server/aftercare.ts";
import { refundOpenCases } from "../server/aftercare-auto.ts";
import { giveUpBody } from "../shared/messages.ts";
import { DeliveryError, answerDelivery } from "../server/delivery.ts";
import { listNotices, markAllRead, notify } from "../server/notifications.ts";
import { handleWebhook } from "../server/webhooks.ts";
import { costMicroUsd, worstCaseMicroUsd } from "../agent/pricing.ts";
import { DEFAULT_MODEL } from "../agent/shopper.ts";
import { LimitError, admit, settle } from "../server/limits.ts";
import type { Limits } from "../server/limits.ts";
import { appendLedger, listLedger } from "../server/ledger.ts";
import { AccountPausedError, InsufficientAllowanceError, createMandate } from "../server/mandates.ts";
import type { GiftGoal } from "../shared/types.ts";
import { MandateNotActiveError } from "../server/payments.ts";
import { clientIp, ipBucket } from "../server/net.ts";
import { PayPalError } from "../server/paypal-port.ts";
import { SHOPS } from "../shops/catalog.ts";
import { escapeHtml, pageText, renderAbout } from "../shops/pages.ts";
import { SESSION_SECONDS, signSession, verifySession } from "./session.ts";

/** What a request gets when it does not say. */
const DEFAULT_MIN_SCORE = 70;
/** The most one request may be: the most an allowance can be set to. What really limits a request is the allowance that is free. */
const MAX_REQUEST_CENTS = 100_000;

export interface AppDeps {
  buy: BuyDeps;
  limits: Limits;
  shops: ShopRef[];
  sessionSecret: string;
  secureCookies: boolean;
  /** The saved sandbox buyer PayPal that every demo account pays with, unless the person connects their own. */
  demoVaultId: string;
  /** Where this app is reached from, such as https://agent-shopper.onrender.com. PayPal sends people back here. */
  publicUrl: string;
  /** Refund price drops and wrong items as soon as they are found, instead of waiting for the owner to press the button. */
  autoRefund?: boolean;
  /** Seconds after a demo account's purchase that the shop's scripted event happens. Unset or 0: no scripted events. */
  demoEventSeconds?: number;
  /** How long a request waits for its turn when another run is going, before it gives up with "a run is already in progress" (default 90). */
  queueWaitSeconds?: number;
  /** Where live agent events go. Tests pass their own. */
  hub?: Hub;
  /** If set (at least 16 characters), GET /api/diag/ip answers to someone who knows it. Used once, after deploying, to set TRUSTED_PROXY_HOPS. */
  diagToken?: string;
  /** True when PayPal and the model are stand-ins. The screens say so. */
  mock: boolean;
  /** Works out the caller's address. Tests replace it. */
  getIp?: (c: Context) => string | undefined;
}

class HttpError extends Error {
  status: 400 | 401 | 403 | 404 | 409 | 415 | 429 | 502;
  constructor(status: HttpError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

const DEMO_ALLOWANCE_CENTS = 100_000;
const COOKIE = "sid";
type Vars = { Variables: { userId: string } };

function str(x: unknown, name: string, min: number, max: number): string {
  if (typeof x !== "string") throw new HttpError(400, `${name} is missing.`);
  const s = x.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${name} must be ${min} to ${max} characters.`);
  return s;
}
function int(x: unknown, name: string, min: number, max: number): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x < min || x > max) throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}.`);
  return x;
}

function idOf(c: Context): string {
  const v = c.req.param("id");
  if (!v) throw new HttpError(404, "Not found.");
  return v;
}

/** Holds a live stream open with a small "ping" every 20 seconds (so proxies do not close it), and lets go the moment the viewer leaves. */
async function keepOpen(stream: SSEStreamingApi, cleanup: () => void): Promise<void> {
  let wake: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  stream.onAbort(() => {
    clearTimeout(timer);
    wake?.();
  });
  try {
    while (!stream.aborted) {
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => undefined);
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, 20_000);
      });
    }
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

export function createApi(pool: Pool, deps: AppDeps): Hono<Vars> {
  const app = new Hono<Vars>();
  const hub = deps.hub ?? new Hub();
  const now = (): Date => (deps.buy.now ?? (() => new Date()))();

  const ipOf = (c: Context): string | undefined => {
    if (deps.getIp) return deps.getIp(c);
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    return clientIp({ xForwardedFor: c.req.header("x-forwarded-for"), remoteAddress: socket, trustedHops: deps.limits.trustedProxyHops });
  };

  async function body(c: Context): Promise<Record<string, unknown>> {
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) throw new HttpError(415, "Send JSON.");
    try {
      const v: unknown = await c.req.json();
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      throw new HttpError(400, "That is not valid JSON.");
    }
  }

  // A page on another site must not be able to make this one act: changes need JSON (which another site
  // cannot send without permission) and, if the browser says where the request came from, the same host.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("origin");
      if (origin) {
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null; // browsers send the word "null" from some sandboxed pages
        }
        if (host !== c.req.header("host")) throw new HttpError(403, "That request came from another site.");
      }
    }
    await next();
  });

  const needUser = async (c: Context<Vars>, next: () => Promise<void>) => {
    const userId = verifySession(getCookie(c, COOKIE), deps.sessionSecret, now().getTime());
    if (!userId) throw new HttpError(401, "Please sign in.");
    const exists = await pool.query("select 1 from users where id = $1", [userId]);
    if (!exists.rows[0]) throw new HttpError(401, "Please sign in.");
    c.set("userId", userId);
    await next();
  };

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof LimitError) {
      if (err.retryAfterSeconds) c.header("Retry-After", String(err.retryAfterSeconds));
      return c.json({ error: err.message, code: err.code, retryAfterSeconds: err.retryAfterSeconds }, 429);
    }
    if (err instanceof InsufficientAllowanceError || err instanceof AccountPausedError) return c.json({ error: err.message }, 409);
    if (err instanceof PayPalError) {
      console.error("PayPal problem:", err.message, err.debugId ? `(debug id ${err.debugId})` : "");
      return c.json({ error: "PayPal could not complete that. Nothing was changed. Try again in a moment." }, 502);
    }
    if (err instanceof MandateNotActiveError) return c.json({ error: err.message }, 409);
    if (err instanceof Error && /^(Request|Proposal) not found/.test(err.message)) return c.json({ error: err.message }, 404);
    // The AI service answered with an error of its own. Say what it means for the person, and keep its words in the log.
    const upstream = err instanceof Error ? (err as Error & { status?: unknown }).status : undefined;
    if (upstream === 401 || upstream === 403) {
      console.error("The AI service refused the app's key. Check ANTHROPIC_API_KEY, then restart the app:", err instanceof Error ? err.message : err);
      return c.json({ error: "The shopper is unavailable right now, so nothing was bought. The app's AI key needs checking." }, 503);
    }
    if (upstream === 429 || upstream === 500 || upstream === 502 || upstream === 503 || upstream === 529) {
      console.error("The AI service is busy or down:", err instanceof Error ? err.message : err);
      return c.json({ error: "The AI service is busy right now, so nothing was bought. Try again in a moment." }, 503);
    }
    console.error("Unexpected error:", err instanceof Error ? err.message : err);
    return c.json({ error: "Something went wrong. Try again in a moment." }, 500);
  });

  // ---------- sign in ----------

  app.post("/api/demo/login", async (c) => {
    const b = await body(c);
    // "own" starts with no payment method, so nothing can be charged until the person connects their own PayPal.
    const own = b["own"] === true;
    await admit(pool, deps.limits, { kind: "signup", ip: ipOf(c), userId: null, reserveMicroUsd: 0 });
    const client = await pool.connect();
    let userId: string;
    try {
      await client.query("begin");
      const u = await client.query<{ id: string }>("insert into users (email, name, paypal_vault_id, paypal_source) values ($1, 'Demo shopper', $2, $3) returning id", [
        `demo-${Math.random().toString(36).slice(2, 10)}@demo.invalid`,
        own ? null : deps.demoVaultId,
        own ? "none" : "demo",
      ]);
      userId = u.rows[0]!.id;
      await client.query("insert into accounts (user_id, monthly_allowance_cents) values ($1, $2)", [userId, DEMO_ALLOWANCE_CENTS]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
    await appendLedger(pool, { userId, kind: "allowance_set", amountCents: DEMO_ALLOWANCE_CENTS, detail: { by: "demo sign-in" } });
    setCookie(c, COOKIE, signSession(userId, deps.sessionSecret, now().getTime()), {
      httpOnly: true, sameSite: "Lax", secure: deps.secureCookies, path: "/", maxAge: SESSION_SECONDS,
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // ---------- everything below needs a signed-in account ----------

  app.get("/api/me", needUser, async (c) => {
    const userId = c.get("userId");
    const [balances, account, payment] = await Promise.all([
      getBalances(pool, userId, now()),
      pool.query<{ paused: boolean }>("select paused from accounts where user_id = $1", [userId]),
      pool.query<{ paypal_source: "demo" | "own" | "none"; paypal_email: string | null }>("select paypal_source, paypal_email from users where id = $1", [userId]),
    ]);
    const p = payment.rows[0]!;
    return c.json({
      balances, paused: account.rows[0]!.paused, mock: deps.mock, runsPerDay: deps.limits.ipRunsPerDay, payment: { source: p.paypal_source, email: p.paypal_email },
      autoRefund: deps.autoRefund === true,
    });
  });

  app.post("/api/pause", needUser, async (c) => {
    const b = await body(c);
    if (typeof b["paused"] !== "boolean") throw new HttpError(400, "paused must be true or false.");
    await pool.query("update accounts set paused = $2, updated_at = now() where user_id = $1", [c.get("userId"), b["paused"]]);
    return c.json({ paused: b["paused"] });
  });

  app.post("/api/allowance", needUser, async (c) => {
    const b = await body(c);
    const cents = int(b["monthlyAllowanceCents"], "The allowance", 0, 100_000);
    await pool.query("update accounts set monthly_allowance_cents = $2, updated_at = now() where user_id = $1", [c.get("userId"), cents]);
    await appendLedger(pool, { userId: c.get("userId"), kind: "allowance_set", amountCents: cents, detail: { by: "owner" } });
    return c.json({ balances: await getBalances(pool, c.get("userId"), now()) });
  });

  // ---------- the PayPal account that pays ----------

  const forget = async (vaultId: string | null, source: string): Promise<void> => {
    // Only an account the person connected themselves is ever forgotten. The shared demo buyer never is.
    if (!vaultId || source !== "own") return;
    try {
      await deps.buy.paypal.deleteVault({ vaultId });
    } catch (err) {
      console.error("Could not ask PayPal to forget a saved account:", err instanceof Error ? err.message : err);
    }
  };

  app.post("/api/paypal/connect", needUser, async (c) => {
    const userId = c.get("userId");
    await body(c);
    await admit(pool, deps.limits, { kind: "connect", ip: ipOf(c), userId, reserveMicroUsd: 0 });
    const setup = await deps.buy.paypal.createVaultSetup({
      returnUrl: `${deps.publicUrl}/api/paypal/return`,
      cancelUrl: `${deps.publicUrl}/api/paypal/cancel`,
      requestId: `connect-${randomUUID()}`,
    });
    await pool.query(
      `insert into pending_vault_setups (user_id, setup_token_id) values ($1, $2)
       on conflict (user_id) do update set setup_token_id = excluded.setup_token_id, created_at = now()`,
      [userId, setup.setupTokenId],
    );
    return c.json({ approveUrl: setup.approveUrl });
  });

  // PayPal sends the person's browser back here after they approve. Only the setup this person started is used,
  // and it is used once, so another person's approval or a repeated visit cannot connect anything.
  app.get("/api/paypal/return", async (c) => {
    const userId = verifySession(getCookie(c, COOKIE), deps.sessionSecret, now().getTime());
    if (!userId) return c.redirect("/?connect=signin", 302);
    const pending = await pool.query<{ setup_token_id: string }>("delete from pending_vault_setups where user_id = $1 returning setup_token_id", [userId]);
    const token = pending.rows[0]?.setup_token_id;
    if (!token) return c.redirect("/?connect=failed#/wallet", 302);
    try {
      const done = await deps.buy.paypal.completeVaultSetup({ setupTokenId: token, requestId: `complete-${token}` });
      const before = await pool.query<{ v: string | null; s: string }>("select paypal_vault_id as v, paypal_source as s from users where id = $1", [userId]);
      await pool.query("update users set paypal_vault_id = $2, paypal_email = $3, paypal_source = 'own' where id = $1", [userId, done.vaultId, done.payerEmail]);
      await appendLedger(pool, { userId, kind: "note", detail: { event: "paypal_connected" } });
      await forget(before.rows[0]?.v ?? null, before.rows[0]?.s ?? "none");
      return c.redirect("/?connect=connected#/wallet", 302);
    } catch (err) {
      console.error("Could not finish connecting PayPal:", err instanceof Error ? err.message : err);
      return c.redirect("/?connect=failed#/wallet", 302);
    }
  });

  app.get("/api/paypal/cancel", async (c) => {
    const userId = verifySession(getCookie(c, COOKIE), deps.sessionSecret, now().getTime());
    if (userId) await pool.query("delete from pending_vault_setups where user_id = $1", [userId]);
    return c.redirect("/?connect=cancelled#/wallet", 302);
  });

  async function switchPayment(c: Context<Vars>, to: "none" | "demo"): Promise<Response> {
    const userId = c.get("userId");
    const before = await pool.query<{ v: string | null; s: string }>("select paypal_vault_id as v, paypal_source as s from users where id = $1", [userId]);
    await pool.query("update users set paypal_vault_id = $2, paypal_email = null, paypal_source = $3 where id = $1", [userId, to === "demo" ? deps.demoVaultId : null, to]);
    await appendLedger(pool, { userId, kind: "note", detail: { event: to === "demo" ? "paypal_switched_to_demo" : "paypal_disconnected" } });
    await forget(before.rows[0]?.v ?? null, before.rows[0]?.s ?? "none");
    return c.json({ payment: { source: to, email: null } });
  }
  app.post("/api/paypal/disconnect", needUser, (c) => switchPayment(c, "none"));
  app.post("/api/paypal/use-demo", needUser, (c) => switchPayment(c, "demo"));

  // Mock mode only: a pretend PayPal consent page, so the whole connect flow can be tried at no cost.
  if (deps.mock) {
    app.get("/mock-paypal/approve", (c) => {
      const ok = c.req.query("ok") ?? "";
      const cancel = c.req.query("cancel") ?? "";
      const base = `${deps.publicUrl}/api/paypal/`;
      if (!ok.startsWith(base) || !cancel.startsWith(base)) return c.text("Not found.", 404);
      return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pretend PayPal</title>
<style>body{margin:0;background:#FFF6F0;color:#2B1F3D;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{background:#fff;border:2px solid #2B1F3D;border-radius:24px;padding:28px;max-width:420px;margin:16px;box-shadow:6px 6px 0 #2B1F3D}a{display:inline-block;margin:8px 8px 0 0;padding:12px 20px;border-radius:24px;border:2px solid #2B1F3D;text-decoration:none;font-weight:700;color:#2B1F3D}a.go{background:#2B1F3D;color:#FDD05A}</style></head>
<body><main><p style="font-weight:700;margin:0 0 4px">PRETEND PAYPAL (mock mode)</p><h1 style="margin:0 0 12px;font-size:24px">Let Agent Shopper pay with your PayPal?</h1>
<p>It can charge your account later for purchases you set up, within your limits. This is a stand-in for PayPal's own page. Nothing is real.</p>
<a class="go" href="${escapeHtml(ok)}">Agree and connect</a><a href="${escapeHtml(cancel)}">Cancel</a></main></body></html>`);
    });
  }

  // ---------- shops ----------

  app.get("/api/shops", needUser, async (c) => {
    const out = [];
    for (const s of SHOPS) {
      // The score uses the same facts the agent reads from the shop's own about page.
      const about = parseAbout({ url: "http://x/about", status: 200, html: renderAbout(s), text: pageText(renderAbout(s)), title: "" });
      const report = scoreSeller(about, { now: now(), injectionSeen: s.hiddenInstruction !== undefined });
      out.push({
        id: s.id, name: s.name, tagline: s.tagline, url: deps.shops.find((x) => x.id === s.id)?.baseUrl ?? null, score: report.score, findings: report.findings.map((f) => f.text),
        categories: [...new Set(s.products.map((p) => p.category))],
      });
    }
    return c.json({ shops: out });
  });

  // ---------- requests ----------

  /** Adds the product's own name and its shop's name to a saved proposal, for the screens. */
  const named = (p: Record<string, any>): Record<string, any> => {
    const shop = SHOPS.find((s) => s.id === p["shop_id"]);
    return { ...p, itemName: shop?.products.find((x) => x.key === p["item_key"])?.name ?? p["item_key"], shopName: shop?.name ?? p["shop_id"] };
  };

  // Requests whose run is going (or waiting its turn) right now, so a reloaded page still says so.
  const working = new Set<string>();

  app.get("/api/requests", needUser, async (c) => {
    const res = await pool.query(
      `select m.id, m.item, m.condition, m.max_price_cents, m.ask_above_cents, to_char(m.deadline, 'YYYY-MM-DD') as deadline,
              m.seller_min_score, m.never_buy, m.set_aside_cents, m.status, m.created_at, m.kind, m.goal, m.closed_outcome,
              (select coalesce(json_agg(row_to_json(p) order by p.created_at), '[]'::json) from (
                 select id, shop_id, item_key, total_cents, decision, checks, reasoning, seller_score, created_at, to_char(delivery_by, 'YYYY-MM-DD') as delivery_by
                 from proposals where mandate_id = m.id
                   and run_id is not distinct from (select run_id from proposals where mandate_id = m.id order by created_at desc limit 1)) p) as proposals,
              (select row_to_json(p) from (
                 select id, shop_id, item_key, total_cents, decision, checks, reasoning, seller_score, to_char(delivery_by, 'YYYY-MM-DD') as delivery_by
                 from proposals where mandate_id = m.id order by created_at desc limit 1) p) as proposal,
              (select row_to_json(o) from (
                 select id, status, total_cents, shop_id from orders where mandate_id = m.id and status not in ('cancelled', 'failed') limit 1) o) as order
       from mandates m where m.user_id = $1 order by m.created_at desc limit 50`,
      [c.get("userId")],
    );
    return c.json({
      requests: res.rows.map((r) => ({
        id: r.id, item: r.item, condition: r.condition, maxPriceCents: r.max_price_cents, askAboveCents: r.ask_above_cents,
        deadline: r.deadline, sellerMinScore: r.seller_min_score, neverBuy: r.never_buy, setAsideCents: r.set_aside_cents,
        status: r.status, createdAt: r.created_at, kind: r.kind, goal: r.goal, closedOutcome: r.closed_outcome ?? null, working: working.has(r.id),
        proposal: r.proposal ? named(r.proposal) : null, proposals: (r.proposals as Array<Record<string, any>>).map(named), order: r.order,
      })),
    });
  });

  app.post("/api/requests", needUser, async (c) => {
    const b = await body(c);
    const gift = b["kind"] === "gift";
    // Gift requests are switched off for now (set ENABLE_GIFTS=1 to bring them back). The code stays.
    if (gift && process.env["ENABLE_GIFTS"] !== "1") throw new HttpError(400, "Gift requests are not available right now.");
    const maxPriceCents = int(b["maxPriceCents"], "The price limit", 100, MAX_REQUEST_CENTS);
    // The price is the only limit. Within it the shopper buys without asking, so the ask-me limit equals the price
    // unless an older client still sends its own. A gift is always the owner's choice and has no separate limit.
    const askAboveCents = gift || b["askAboveCents"] === undefined ? maxPriceCents : int(b["askAboveCents"], "The ask-me limit", 100, maxPriceCents);
    // Everything else has a sensible default, so a request is just "what" and "how much".
    const sellerMinScore = b["sellerMinScore"] === undefined ? DEFAULT_MIN_SCORE : int(b["sellerMinScore"], "The minimum shop score", 0, 100);
    const condition = b["condition"] === "any" ? "any" : "new";
    const deadline = b["deadline"] === undefined ? new Date(now().getTime() + 30 * 86_400_000).toISOString().slice(0, 10) : str(b["deadline"], "The deadline", 10, 10);
    const when = Date.parse(`${deadline}T00:00:00Z`);
    if (Number.isNaN(when) || when < now().getTime() - 86_400_000 || when > now().getTime() + 400 * 86_400_000) {
      throw new HttpError(400, "The deadline must be a date within the next year.");
    }
    // Nothing is banned unless a request says so: the app has no built-in list of things it will not buy.
    const rawBanned = Array.isArray(b["neverBuy"]) ? b["neverBuy"] : [];
    if (rawBanned.length > 10) throw new HttpError(400, "Ban at most 10 categories.");
    const neverBuy = rawBanned.map((x) => str(x, "A banned category", 1, 30).toLowerCase());

    let item: string;
    let goal: GiftGoal | undefined;
    if (gift) {
      const clean = (v: unknown, name: string, min: number, max: number): string => str(typeof v === "string" ? v.replace(/\s+/g, " ") : v, name, min, max);
      goal = {
        recipient: clean(b["recipient"], "Who the gift is for", 1, 30),
        occasion: clean(b["occasion"], "The occasion", 1, 30),
        interests: b["interests"] === undefined || b["interests"] === null || (typeof b["interests"] === "string" && !b["interests"].trim()) ? "" : clean(b["interests"], "What they like", 1, 200),
      };
      item = `Gift for ${goal.recipient}: ${goal.occasion}`;
    } else {
      item = str(b["item"], "What to buy", 3, 80);
    }
    const { mandateId } = await createMandate(
      pool,
      { userId: c.get("userId"), item, condition, maxPriceCents, askAboveCents, deadline, sellerMinScore, neverBuy, setAsideCents: maxPriceCents, ...(goal ? { kind: "gift" as const, goal } : {}) },
      now(),
    );
    return c.json({ id: mandateId }, 201);
  });

  app.post("/api/requests/:id/cancel", needUser, async (c) => {
    const userId = c.get("userId");
    const r = await pool.query<{ set_aside_cents: number }>(
      "update mandates set status = 'cancelled' where id = $1 and user_id = $2 and status = 'active' returning set_aside_cents",
      [idOf(c), userId],
    );
    if (!r.rows[0]) throw new HttpError(404, "Request not found, or it is no longer active.");
    await appendLedger(pool, { userId, mandateId: idOf(c), kind: "set_aside_release", amountCents: r.rows[0].set_aside_cents });
    return c.json({ ok: true });
  });

  async function needPayment(userId: string): Promise<void> {
    const r = await pool.query<{ v: string | null }>("select paypal_vault_id as v from users where id = $1", [userId]);
    if (!r.rows[0]?.v) throw new HttpError(409, "Connect your PayPal account first. You can do that on the Wallet page.");
  }

  async function notPaused(userId: string): Promise<void> {
    const a = await pool.query<{ paused: boolean }>("select paused from accounts where user_id = $1", [userId]);
    if (a.rows[0]?.paused) throw new HttpError(409, "Your shopper is paused. Resume it to continue.");
  }

  app.post("/api/requests/:id/run", needUser, async (c) => {
    const userId = c.get("userId");
    await body(c);
    await needPayment(userId);
    await notPaused(userId);
    const live = hub.start(userId);
    const mandateId = idOf(c);
    const item = (await pool.query<{ item: string }>("select item from mandates where id = $1 and user_id = $2", [mandateId, userId])).rows[0]?.item;
    live.emit({ type: "start", ...(item ? { item } : {}) });
    working.add(mandateId);
    let r;
    try {
      // Several requests at once take their turns, one after another, instead of the later ones failing: the shopper does
      // them in the order they come, waiting (up to a limit) while another run is going.
      const giveUpWaitingAt = Date.now() + (deps.queueWaitSeconds ?? 90) * 1000;
      for (;;) {
        try {
          r = await guardedProposeAndBuy(pool, { ...deps.buy, limits: deps.limits, onEvent: live.emit }, { userId, mandateId, shops: deps.shops, ip: ipOf(c) });
          break;
        } catch (err) {
          if (err instanceof LimitError && err.code === "busy" && Date.now() < giveUpWaitingAt) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      live.emit({ type: "end", result: "stopped" });
      throw err;
    } finally {
      working.delete(mandateId);
    }
    const run = { actions: r.run.actions, rejections: r.run.rejections, steps: r.run.steps };
    if (r.stage === "agent" && r.outcome.status === "gave_up") {
      // The shopper has decided there is nothing to buy: the request is closed, its held money is freed, and what it said is kept.
      const closed = await pool.query<{ set_aside_cents: number }>(
        "update mandates set status = 'expired', closed_outcome = $3 where id = $1 and user_id = $2 and status = 'active' returning set_aside_cents",
        [mandateId, userId, JSON.stringify({ reason: r.outcome.reason, tried: r.outcome.tried ?? [], closest: r.outcome.closest ?? null })],
      );
      if (closed.rows[0]) await appendLedger(pool, { userId, mandateId, kind: "set_aside_release", amountCents: closed.rows[0].set_aside_cents });
      await notify(pool, { userId, kind: "not_found", text: `Nothing was bought for "${item ?? "that"}". ${giveUpBody(r.outcome)}`, href: "#/", key: `run:${mandateId}` });
    }
    if (r.stage === "agent") return c.json({ stage: "agent", outcome: r.outcome, closed: r.outcome.status === "gave_up", ...run });
    if (r.stage === "shortlist") return c.json({ stage: "shortlist", picks: r.picks, summary: r.summary, ...run });
    if (r.stage === "owner") return c.json({ stage: "owner", proposalId: r.proposalId, totalCents: r.totalCents, ...run });
    return c.json({ stage: "purchase", proposalId: r.proposalId, result: r.result, ...run });
  });

  app.post("/api/requests/:id/approve", needUser, async (c) => {
    const userId = c.get("userId");
    const b = await body(c);
    await needPayment(userId);
    await notPaused(userId);
    const live = hub.start(userId);
    live.emit({ type: "start" });
    let result;
    try {
      result = await guardedApproveAndBuy(pool, { ...deps.buy, limits: deps.limits, onEvent: live.emit }, {
        userId, mandateId: idOf(c), proposalId: str(b["proposalId"], "The proposal", 1, 60),
        approvedTotalCents: int(b["approvedTotalCents"], "The approved amount", 1, 1_000_000), ip: ipOf(c),
      });
    } catch (err) {
      live.emit({ type: "end", result: "stopped" });
      throw err;
    }
    live.emit({ type: "end", result: result.status === "paid_out" || result.status === "payout_pending" || result.status === "payout_failed" ? "bought" : "stopped" });
    return c.json({ result });
  });

  // ---------- live view ----------

  // Your own runs, in full. The page connects once and keeps listening.
  // For the host's health check. It says nothing about the app and touches nothing.
  app.get("/health", (c) => c.text("ok"));

  // After deploying: shows what the app sees of a request, so TRUSTED_PROXY_HOPS can be set from evidence, not a guess.
  // It answers only to someone who knows DIAG_TOKEN, and only ever shows the caller their own request.
  app.get("/api/diag/ip", (c) => {
    const token = deps.diagToken;
    const supplied = c.req.header("x-diag-token") ?? "";
    if (!token || token.length < 16 || supplied.length !== token.length || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new HttpError(404, "Not found.");
    const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress;
    const forwarded = c.req.header("x-forwarded-for") ?? null;
    const entries = (forwarded ?? "").split(",").map((e) => e.trim()).filter(Boolean);
    return c.json({
      socketAddress: socket ?? null,
      xForwardedFor: forwarded,
      otherHeaders: Object.fromEntries(["x-real-ip", "true-client-ip", "cf-connecting-ip", "forwarded", "x-forwarded-proto"].map((h) => [h, c.req.header(h) ?? null])),
      trustedProxyHops: deps.limits.trustedProxyHops,
      countedAs: ipBucket(ipOf(c) ?? "unknown"),
      // What each possible setting would have counted this caller as, so the right one can be read off.
      ifHopsWere: Object.fromEntries([0, 1, 2, 3, 4].map((n) => [String(n), ipBucket(clientIp({ xForwardedFor: forwarded, remoteAddress: socket, trustedHops: n }))])),
      entriesInHeader: entries.length,
    });
  });

  app.get("/api/live", needUser, (c) => {
    const userId = c.get("userId");
    return streamSSE(c, async (stream) => {
      const off = hub.onPrivate(userId, (f) => void stream.writeSSE({ data: JSON.stringify(f) }).catch(() => undefined));
      await keepOpen(stream, off);
    });
  });

  // How many shoppers are working right now, and how many tasks have finished today. Public and cheap: numbers and nothing else.
  // Someone who is signed in also gets their own count.
  app.get("/api/town/status", (c) => {
    c.header("Cache-Control", "no-store");
    const viewer = verifySession(getCookie(c, COOKIE), deps.sessionSecret, now().getTime());
    return c.json({ shoppingNow: hub.activeRuns(), finishedToday: hub.finishedToday(), ...(viewer ? { mineToday: hub.finishedToday(viewer) } : {}) });
  });

  // Everyone's runs, anonymous. No sign-in needed, so it is limited per address and in total.
  app.get("/api/town", (c) => {
    const ip = ipBucket(ipOf(c) ?? "unknown");
    // Signed in or not, anyone may watch. If they are signed in, their own agents are marked, for them alone.
    const viewer = verifySession(getCookie(c, COOKIE), deps.sessionSecret, now().getTime());
    return streamSSE(c, async (stream) => {
      let off: (() => void) | null = null;
      off = hub.onPublic(ip, (f) => void stream.writeSSE({ data: JSON.stringify(f) }).catch(() => undefined), { perIp: 4, total: 150 }, viewer);
      if (!off) {
        await stream.writeSSE({ event: "busy", data: "" });
        return;
      }
      await stream.writeSSE({ event: "ready", data: "" });
      await keepOpen(stream, off);
    });
  });

  // ---------- aftercare: problems with an order, and refunds ----------

  const aftercare = (): AftercareDeps => ({ paypal: deps.buy.paypal, fetchPage: deps.buy.fetchPage, shops: deps.shops, now });
  const caseJson = (r: Awaited<ReturnType<typeof listCases>>[number]) => ({
    id: r.id, orderId: r.orderId, kind: r.kind, status: r.status, amountCents: r.amountCents, summary: r.summary, evidence: r.evidence,
    draft: r.draft, failure: r.failure, createdAt: r.createdAt, itemName: r.itemName, shopName: r.shopName,
  });

  app.get("/api/cases", needUser, async (c) => c.json({ cases: (await listCases(pool, c.get("userId"))).map(caseJson) }));

  // Looks at the person's paid orders for a price drop or a wrong item, and opens or updates cases. Nothing is refunded here.
  app.post("/api/aftercare/check", needUser, async (c) => {
    await body(c);
    const userId = c.get("userId");
    await checkOrders(pool, aftercare(), userId);
    // With automatic refunds on, what is owed is refunded right now, without a button.
    if (deps.autoRefund) await refundOpenCases(pool, aftercare(), { userId });
    return c.json({ cases: (await listCases(pool, userId)).map(caseJson) });
  });

  // ---------- notifications ----------

  app.get("/api/notifications", needUser, async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(await listNotices(pool, c.get("userId")));
  });

  app.post("/api/notifications/read", needUser, async (c) => {
    await body(c);
    await markAllRead(pool, c.get("userId"));
    return c.json({ ok: true });
  });

  // The owner presses "refund me". They name no amount: the rules work it out again right now.
  app.post("/api/cases/:id/refund", needUser, async (c) => {
    await body(c);
    await notPaused(c.get("userId"));
    const result = await refundCase(pool, aftercare(), { userId: c.get("userId"), caseId: idOf(c) });
    if (result.status === "not_open") throw new HttpError(409, "That case is no longer open.");
    return c.json({ result });
  });

  app.post("/api/cases/:id/decline", needUser, async (c) => {
    await body(c);
    if (!(await declineCase(pool, c.get("userId"), idOf(c)))) throw new HttpError(409, "That case is no longer open.");
    return c.json({ ok: true });
  });

  // The shopper puts the evidence into words. It counts as a shopper run for the usage limits, because it uses the model.
  app.post("/api/cases/:id/draft", needUser, async (c) => {
    await body(c);
    const userId = c.get("userId");
    const found = await loadCase(pool, userId, idOf(c));
    if (!found) throw new HttpError(404, "Case not found.");
    const model = deps.buy.modelName ?? DEFAULT_MODEL;
    const admission = await admit(pool, deps.limits, { kind: "agent_run", ip: ipOf(c), userId, reserveMicroUsd: worstCaseMicroUsd(model, 4000) });
    let actual: number | null = null;
    try {
      const d = await draftMessage(deps.buy.model, model, found);
      actual = costMicroUsd(model, d.usage);
      if (!d.text) throw new HttpError(502, "The shopper could not write the message. Try again.");
      await saveDraft(pool, userId, found.id, d.text);
      return c.json({ draft: d.text });
    } finally {
      await settle(pool, admission.id, actual);
    }
  });

  // PayPal's own messages. No sign-in: anyone can post here, so nothing is believed until PayPal vouches for it.
  app.post("/api/paypal/webhook", async (c) => {
    const raw = await c.req.text();
    if (raw.length === 0 || raw.length > 200_000) throw new HttpError(400, "That is not a webhook.");
    const headers: Record<string, string> = {};
    for (const [k, v] of c.req.raw.headers) headers[k.toLowerCase()] = v;
    if (!(await deps.buy.paypal.verifyWebhook({ headers, rawBody: raw }))) throw new HttpError(401, "This could not be confirmed as coming from PayPal.");
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "That is not valid JSON.");
    }
    const handled = await handleWebhook(pool, event);
    return c.json({ ok: true, outcome: handled.outcome });
  });

  // ---------- money and orders ----------

  app.get("/api/ledger", needUser, async (c) => {
    const rows = await listLedger(pool, c.get("userId"), 200);
    return c.json({ entries: rows.map((r) => ({ id: r.id, at: r.at, kind: r.kind, amountCents: r.amountCents, mandateId: r.mandateId, detail: r.detail })) });
  });

  app.get("/api/orders", needUser, async (c) => {
    const res = await pool.query(
      `select o.id, o.status, o.total_cents, o.refunded_cents, o.shop_id, s.name as shop_name, o.created_at, o.failure,
              so.item_key, so.status as shop_status, to_char(so.promised_by, 'YYYY-MM-DD') as promised_by, o.delivery_answer
       from orders o join shops s on s.id = o.shop_id left join shop_orders so on so.order_id = o.id
       where o.user_id = $1 order by o.created_at desc limit 50`,
      [c.get("userId")],
    );
    return c.json({
      orders: res.rows.map((r) => ({
        id: r.id, status: r.status, totalCents: r.total_cents, shopId: r.shop_id, shopName: r.shop_name, createdAt: r.created_at,
        failure: r.failure, itemKey: r.item_key, shopStatus: r.shop_status, promisedBy: r.promised_by, refundedCents: r.refunded_cents, deliveryAnswer: r.delivery_answer,
        itemName: (() => { const shop = SHOPS.find((s) => s.id === r.shop_id); return shop?.products.find((p) => p.key === r.item_key)?.name ?? r.item_key; })(),
      })),
    });
  });

  // Once an order is delivered the owner confirms it arrived as ordered, or reports a problem. A reported problem is refunded only
  // when the shop's own delivery record also shows something other than what was ordered.
  app.post("/api/orders/:id/delivery", needUser, async (c) => {
    const b = await body(c);
    if (typeof b["arrived"] !== "boolean") throw new HttpError(400, "arrived must be true or false.");
    try {
      return c.json(await answerDelivery(pool, aftercare(), { userId: c.get("userId"), orderId: idOf(c), arrived: b["arrived"] }));
    } catch (err) {
      if (err instanceof DeliveryError) throw new HttpError(err.status === 404 ? 404 : 409, err.message);
      throw err;
    }
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));
  return app;
}
