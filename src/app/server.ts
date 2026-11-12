// Starts the web app: the API and, if it has been built, the screens.
//   npm run app         real Claude and the PayPal sandbox (spends money: Anthropic, and sandbox PayPal)
//   npm run app:mock    a scripted shopper and a pretend PayPal, for trying the screens at no cost

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import Anthropic from "@anthropic-ai/sdk";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { Hono } from "hono";
import { createPageFetcher } from "../agent/pages.ts";
import type { ModelPort, ShopRef } from "../agent/shopper.ts";
import { createPool, migrate, waitForDatabase } from "../server/db.ts";
import { FakePayPal } from "../server/fake-paypal.ts";
import { limitsFromEnv, pruneAdmissions } from "../server/limits.ts";
import { createPayPalClient } from "../server/paypal.ts";
import { SHOPS } from "../shops/catalog.ts";
import { createShopsApp, shopAddress } from "../shops/mount.ts";
import { seedShops } from "../shops/service.ts";
import { createApi } from "./api.ts";
import type { AppDeps } from "./api.ts";
import { runAftercareSweep } from "../server/aftercare-auto.ts";
import { createMockModel } from "./mock.ts";

const env = process.env;
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};
const need = (name: string): string => env[name]?.trim() || fail(`${name} is not set. Add it to .env (see .env.example).`);

const mock = env["MOCK_SERVICES"] === "1";
const production = env["NODE_ENV"] === "production";
const limits = limitsFromEnv(env);

let sessionSecret = env["SESSION_SECRET"]?.trim() ?? "";
if (production && sessionSecret.length < 32) fail("SESSION_SECRET must be set to at least 32 random characters when NODE_ENV=production.");
if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET is not set, so a temporary one is used: everyone is signed out whenever the app restarts.");
}

const port = Number(env["PORT"] ?? 3000);
// PayPal sends people back to this address after they approve, so it must be the address people really use.
// Render tells each web service its own address in RENDER_EXTERNAL_URL, so PUBLIC_URL only needs setting for a custom domain.
const publicUrl = (env["PUBLIC_URL"]?.trim() || env["RENDER_EXTERNAL_URL"]?.trim() || (production ? fail("PUBLIC_URL must be set when NODE_ENV=production, for example https://your-app.onrender.com.") : `http://localhost:${port}`)).replace(/\/$/, "");

// The demo shops live inside this app, at /shops/<name>, and so does the owner's control panel at /control.
const shops: ShopRef[] = SHOPS.map((shop) => ({ id: shop.id, baseUrl: shopAddress(publicUrl, shop.id) }));
const controlToken = env["CONTROL_TOKEN"]?.trim();
if (controlToken && controlToken.length < 12) fail("CONTROL_TOKEN must be at least 12 characters.");
if (production && !controlToken) console.warn("CONTROL_TOKEN is not set, so the control panel is not available. Set it to use /control.");

const pool = createPool(need("DATABASE_URL"));
await waitForDatabase(pool, { log: console.log });
const shopsApp = createShopsApp(pool, { publicUrl, ...(controlToken ? { controlToken } : {}), allowOpenControl: !production });
await migrate(pool);
await seedShops(pool, env["SHOP_PAYEE_EMAIL"]?.trim() || (mock ? "shop@example.com" : need("SHOP_PAYEE_EMAIL")));

let model: ModelPort;
if (mock) {
  model = createMockModel({ delayMs: 900 });
} else {
  // No call may hang: 60 seconds each, and one retry for a passing network or overload error. The whole run has its own deadline too.
  const client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
  model = (params, opts) => client.messages.create(params, opts?.signal ? { signal: opts.signal } : undefined);
}

// Automatic aftercare. AUTO_REFUND=0 turns automatic refunds off (the owner then presses the button). DEMO_EVENT_SECONDS is how long
// after a demo account's purchase the shop's scripted price drop or wrong item happens (0 turns the scripted events off).
const autoRefund = env["AUTO_REFUND"]?.trim() !== "0";
const demoEventSeconds = Number(env["DEMO_EVENT_SECONDS"] ?? 60);
if (!Number.isFinite(demoEventSeconds) || demoEventSeconds < 0) fail("DEMO_EVENT_SECONDS must be a number of seconds, 0 or more.");

const appDeps: AppDeps = {
  buy: {
    paypal: mock ? new FakePayPal() : createPayPalClient({ clientId: need("PAYPAL_CLIENT_ID"), clientSecret: need("PAYPAL_CLIENT_SECRET"), ...(env["PAYPAL_WEBHOOK_ID"]?.trim() ? { webhookId: env["PAYPAL_WEBHOOK_ID"].trim() } : {}) }),
    model,
    // The shopper reads the shops inside this process (no network), and only addresses under /shops/<name>: never this app's own API or screens.
    fetchPage: createPageFetcher({
      allowedHosts: [new URL(publicUrl).host],
      allowedPrefixes: shops.map((x) => x.baseUrl),
      fetchImpl: (async (input: string | URL | Request) => {
        const u = new URL(String(input));
        return shopsApp.request(`${u.pathname}${u.search}`);
      }) as typeof fetch,
    }),
  },
  limits,
  shops,
  sessionSecret,
  secureCookies: production,
  publicUrl,
  ...(env["DIAG_TOKEN"]?.trim() ? { diagToken: env["DIAG_TOKEN"].trim() } : {}),
  demoVaultId: env["DEMO_VAULT_ID"]?.trim() || env["VAULT_ID"]?.trim() || (mock ? "MOCK-VAULT" : need("DEMO_VAULT_ID")),
  mock,
  autoRefund,
  demoEventSeconds,
};
const api = createApi(pool, appDeps);

// Not strict about a trailing slash, so a shop's address works with or without one at the end.
const app = new Hono({ strict: false });
app.route("/", api);
app.route("/", shopsApp);
// An unknown address under /api is an error for the caller, not the home page.
app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
if (existsSync("./web/dist/index.html")) {
  app.use("/*", serveStatic({ root: "./web/dist" }));
  app.get("*", serveStatic({ path: "./web/dist/index.html" }));
} else {
  app.get("/", (c) => c.text("The API is running. The screens are not built yet: run npm run web:build."));
}

serve({ fetch: app.fetch, port });
console.log(`Agent Shopper is open at http://localhost:${port}${mock ? "  (MOCK MODE: scripted shopper, pretend PayPal)" : ""}`);

// Every 30 seconds: scripted demo events that are due, then every recent paid order is checked and, if a refund is owed, refunded.
// It runs on the server, so it happens even when nobody has the app open. One pass at a time.
if (autoRefund || demoEventSeconds > 0) {
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void runAftercareSweep(pool, { paypal: appDeps.buy.paypal, fetchPage: appDeps.buy.fetchPage, shops }, { demoEventSeconds }, autoRefund)
      .catch((err) => console.error(`Aftercare pass failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        sweeping = false;
      });
  }, 30_000).unref();
}

// Old usage records are only needed for the 24-hour limits.
setInterval(() => void pruneAdmissions(pool).catch(() => undefined), 6 * 60 * 60 * 1000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}
