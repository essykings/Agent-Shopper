// Partner route probe (sandbox): can our platform onboard a shop as a seller?
//
//   node --env-file=.env scripts/partner-probe.ts            create a seller sign-up link
//   node --env-file=.env scripts/partner-probe.ts status ID  read the result for tracking id ID
//
// Needs in .env: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET
// Optional:      PLATFORM_BN_CODE (App settings > Reports), PARTNER_MERCHANT_ID (needed for "status")
//                PARTNER_PRODUCT (default EXPRESS_CHECKOUT; PPCP also documented)

const API = "https://api-m.sandbox.paypal.com";
const TIMEOUT_MS = 20_000;

const REQUIRED = ["PLATFORM_CLIENT_ID", "PLATFORM_CLIENT_SECRET"] as const;

function checkEnv() {
  console.log("Settings (names and lengths only):");
  let missing = false;
  for (const name of [...REQUIRED, "PLATFORM_BN_CODE", "PARTNER_MERCHANT_ID"]) {
    const v = process.env[name] ?? "";
    const required = (REQUIRED as readonly string[]).includes(name);
    console.log(`  ${name}: ${v ? `${v.length} chars` : required ? "MISSING" : "not set"}`);
    if (required && !v) missing = true;
  }
  if (missing) {
    console.error("\nAdd the missing settings to .env (see .env.example), then run again.");
    process.exit(1);
  }
}

async function call(step: string, path: string, init: RequestInit) {
  try {
    const res = await fetch(API + path, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let body: any = text;
    try { body = text ? JSON.parse(text) : {}; } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, body, debugId: res.headers.get("paypal-debug-id") };
  } catch (err: any) {
    throw new Error(`${step}: ${err?.name === "TimeoutError" ? `no answer after ${TIMEOUT_MS / 1000}s` : err?.message}`);
  }
}

function explain(step: string, r: { status: number; body: any; debugId: string | null }) {
  const b = r.body ?? {};
  const details = Array.isArray(b.details)
    ? b.details.map((d: any) => `${d.issue ?? ""}${d.description ? ` (${d.description})` : ""}`).join("; ")
    : "";
  const hint = r.status === 401 || r.status === 403
    ? " | Likely meaning: the platform features are not switched on for this sandbox app yet. PayPal's docs say to share the sandbox Client ID with your PayPal account manager."
    : "";
  return `${step} failed: HTTP ${r.status} ${b.name ?? b.error ?? ""} ${b.message ?? b.error_description ?? ""}${details ? ` | ${details}` : ""}${r.debugId ? ` | debug id ${r.debugId}` : ""}${hint}`;
}

async function token(): Promise<string> {
  const id = process.env.PLATFORM_CLIENT_ID!, secret = process.env.PLATFORM_CLIENT_SECRET!;
  const r = await call("Get access token", "/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(explain("Get access token", r));
  return r.body.access_token;
}

function headers(t: string): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${t}`, "Content-Type": "application/json" };
  if (process.env.PLATFORM_BN_CODE) h["PayPal-Partner-Attribution-Id"] = process.env.PLATFORM_BN_CODE;
  return h;
}

async function create(t: string) {
  const trackingId = `shop-${Date.now()}`;
  const r = await call("Create seller sign-up link", "/v2/customer/partner-referrals", {
    method: "POST",
    headers: headers(t),
    body: JSON.stringify({
      tracking_id: trackingId,
      operations: [{
        operation: "API_INTEGRATION",
        api_integration_preference: {
          rest_api_integration: {
            integration_method: "PAYPAL",
            integration_type: "THIRD_PARTY",
            third_party_details: { features: ["PAYMENT", "REFUND"] },
          },
        },
      }],
      products: [process.env.PARTNER_PRODUCT || "EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      partner_config_override: { return_url: "https://example.com/onboarded" },
    }),
  });
  if (!r.ok) throw new Error(explain("Create seller sign-up link", r));
  const link = r.body.links?.find((l: any) => l.rel === "action_url")?.href;
  console.log("\nPASS  PayPal accepted the platform call. Our app can create seller sign-ups.");
  console.log(`\nTracking id: ${trackingId}`);
  console.log("\nOpen this link, sign in as the SANDBOX BUSINESS account of a demo shop, and agree to the permissions:");
  console.log(`\n  ${link}\n`);
  console.log("PayPal then sends you to example.com with merchantIdInPayPal=... in the address.");
  console.log("That page is expected. Copy the 13-character merchantIdInPayPal value (it is not a secret),");
  console.log(`then run:  node --env-file=.env scripts/partner-probe.ts status ${trackingId}`);
}

async function status(t: string, trackingId: string) {
  const partner = process.env.PARTNER_MERCHANT_ID;
  if (!partner) throw new Error("Set PARTNER_MERCHANT_ID in .env (the merchant ID of the platform's own sandbox business account) to read the result.");
  const r = await call("Read seller status", `/v1/customer/partners/${partner}/merchant-integrations?tracking_id=${encodeURIComponent(trackingId)}`, {
    method: "GET",
    headers: headers(t),
  });
  if (!r.ok) throw new Error(explain("Read seller status", r));
  const b = r.body;
  console.log(`\nSeller merchant id: ${b.merchant_id ?? "(not shown)"}`);
  console.log(`Payments receivable: ${b.payments_receivable}   Email confirmed: ${b.primary_email_confirmed}`);
  const scopes = (b.oauth_integrations ?? []).flatMap((o: any) => (o.oauth_third_party ?? []).flatMap((x: any) => x.scopes ?? []));
  console.log(`Permissions granted to our platform: ${scopes.length ? scopes.join(", ") : "(none listed)"}`);
}

async function main() {
  checkEnv();
  const t = await token();
  console.log("\nConnected to PayPal sandbox as the platform app.");
  const [mode, arg] = process.argv.slice(2);
  if (mode === "status") {
    if (!arg) throw new Error("Usage: status TRACKING_ID");
    await status(t, arg);
  } else {
    await create(t);
  }
}

main().catch((err) => {
  console.error(`\nStopped. ${err.message}`);
  process.exit(1);
});
