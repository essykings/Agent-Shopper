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
import { seedShops } from "../shops/service.ts";
import { createApi } from "./api.ts";
import { createMockModel } from "./mock.ts";
import { normalizeBaseUrl } from "./urls.ts";

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

// On Render these are the shops' private addresses ("shop-northgear:10000"), which have no http:// in front.
const shopUrl = (name: string, fallback: string): string => {
  try {
    return normalizeBaseUrl(env[name]?.trim() || fallback);
  } catch (err) {
    return fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};
const shops: ShopRef[] = [
  { id: "northgear", baseUrl: shopUrl("SHOP_NORTHGEAR_URL", "http://northgear.localhost:4101") },
  { id: "deal-zone", baseUrl: shopUrl("SHOP_DEAL_ZONE_URL", "http://deal-zone.localhost:4102") },
  { id: "trailhead", baseUrl: shopUrl("SHOP_TRAILHEAD_URL", "http://trailhead.localhost:4103") },
];

const port = Number(env["PORT"] ?? 3000);
// PayPal sends people back to this address after they approve, so it must be the address people really use.
// Render tells each web service its own address in RENDER_EXTERNAL_URL, so PUBLIC_URL only needs setting for a custom domain.
const publicUrl = (env["PUBLIC_URL"]?.trim() || env["RENDER_EXTERNAL_URL"]?.trim() || (production ? fail("PUBLIC_URL must be set when NODE_ENV=production, for example https://your-app.onrender.com.") : `http://localhost:${port}`)).replace(/\/$/, "");

const pool = createPool(need("DATABASE_URL"));
await waitForDatabase(pool, { log: console.log });
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

const api = createApi(pool, {
  buy: {
    paypal: mock ? new FakePayPal() : createPayPalClient({ clientId: need("PAYPAL_CLIENT_ID"), clientSecret: need("PAYPAL_CLIENT_SECRET"), ...(env["PAYPAL_WEBHOOK_ID"]?.trim() ? { webhookId: env["PAYPAL_WEBHOOK_ID"].trim() } : {}) }),
    model,
    fetchPage: createPageFetcher({ allowedHosts: shops.map((s) => new URL(s.baseUrl).host) }),
  },
  limits,
  shops,
  sessionSecret,
  secureCookies: production,
  publicUrl,
  ...(env["DIAG_TOKEN"]?.trim() ? { diagToken: env["DIAG_TOKEN"].trim() } : {}),
  demoVaultId: env["DEMO_VAULT_ID"]?.trim() || env["VAULT_ID"]?.trim() || (mock ? "MOCK-VAULT" : need("DEMO_VAULT_ID")),
  mock,
});

const app = new Hono();
app.route("/", api);
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

// Old usage records are only needed for the 24-hour limits.
setInterval(() => void pruneAdmissions(pool).catch(() => undefined), 6 * 60 * 60 * 1000).unref();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}
