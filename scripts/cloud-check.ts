// Tests the DEPLOYED app, from your machine, over the real internet.
//
//   node scripts/cloud-check.ts https://agent-shopper-app.onrender.com
//   (the shops live at <app>/shops/<name> and the control panel at <app>/control, so one address is enough)
//
// Settings are read from the environment by name and never printed:
//   DIAG_TOKEN      the app's DIAG_TOKEN (Render dashboard > the app > Environment). Needed for the address check.
//   CONTROL_TOKEN   the app's CONTROL_TOKEN (the control panel's password). Needed for the price-drop and wrong-item refund test.
//
// What it does NOT do: spend money. The full purchase flow only runs when the app says it is in mock mode
// (a scripted shopper and a pretend PayPal). On a live app it checks everything else and skips that part.
// It uses one demo sign-up (the limit is 5 per address per day) and always puts the control panel's price back.

import { ipBucket } from "../src/server/net.ts";

const args = process.argv.slice(2);
const appUrl = (args.find((a) => /^https?:\/\//.test(a)) ?? "").replace(/\/$/, "");
if (!appUrl) {
  console.error("Usage: node scripts/cloud-check.ts https://<your app>.onrender.com [--quick]");
  process.exit(1);
}
const controlUrl = `${appUrl}/control`;
const shopUrls = ["northgear", "deal-zone", "trailhead"].map((id) => `${appUrl}/shops/${id}`);
const quick = args.includes("--quick");
const diagToken = process.env["DIAG_TOKEN"] ?? "";
const controlToken = process.env["CONTROL_TOKEN"] ?? "";

console.log(`Checking ${appUrl}`);
console.log("Settings (names and lengths only):");
for (const [n, v] of [["DIAG_TOKEN", diagToken], ["CONTROL_TOKEN", controlToken]] as const) console.log(`  ${n}: ${v ? `${v.length} chars` : "not set"}`);
console.log("");

const results: Array<{ status: "PASS" | "FAIL" | "SKIP" | "NOTE"; name: string; detail: string }> = [];
const report = (status: "PASS" | "FAIL" | "SKIP" | "NOTE", name: string, detail = ""): void => {
  results.push({ status, name, detail });
  console.log(`${status.padEnd(5)} ${name}${detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
};
const check = (ok: boolean, name: string, detail = ""): boolean => {
  report(ok ? "PASS" : "FAIL", name, detail);
  return ok;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Reply {
  status: number;
  json: any;
  text: string;
  headers: Headers;
  ms: number;
}
async function call(method: string, base: string, path: string, opts: { body?: unknown; form?: Record<string, string>; headers?: Record<string, string>; cookie?: string; timeoutMs?: number } = {}): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers["cookie"] = opts.cookie;
  let body: string | undefined;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  }
  const t0 = Date.now();
  const res = await fetch(base + path, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json, text, headers: res.headers, ms: Date.now() - t0 };
}

// ---- the live stream (Server-Sent Events): opened first and read in the background, so it also catches the purchase later ----
interface SseEvent {
  at: number;
  name: string;
  data: any;
}
function listen(url: string, ms: number) {
  const events: SseEvent[] = [];
  const started = Date.now();
  let headersMs = -1;
  let contentEncoding = "";
  let status = 0;
  let error = "";
  const done = (async () => {
    try {
      const res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(ms) });
      status = res.status;
      headersMs = Date.now() - started;
      contentEncoding = res.headers.get("content-encoding") ?? "";
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1] ?? "message";
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          let data: any = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = raw;
          }
          events.push({ at: Date.now() - started, name, data });
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.name : String(err);
    }
  })();
  return { events, done, info: () => ({ status, headersMs, contentEncoding, error, ranMs: Date.now() - started }) };
}

const STREAM_MS = quick ? 25_000 : 70_000;
const stream = listen(`${appUrl}/api/town`, STREAM_MS);

// ---- 1. reachable, and how long a cold start takes ----
try {
  const first = await call("GET", appUrl, "/health", { timeoutMs: 120_000 });
  check(first.status === 200 && first.text === "ok", "The app answers its health check", `${first.ms} ms${first.ms > 8000 ? " (slow: it was probably starting up)" : ""}`);
  const home = await call("GET", appUrl, "/");
  check(home.status === 200 && /id="root"/.test(home.text), "The screens are served", `HTTP ${home.status}, ${home.text.length} bytes${/^https:/.test(appUrl) ? "" : ". Not https."}`);
  check(/^https:/.test(appUrl), "The address is https");
} catch (err) {
  report("FAIL", "The app is reachable", err instanceof Error ? err.message : String(err));
  console.log("\nThe app did not answer, so nothing else can be checked.");
  process.exit(1);
}

// ---- 2. the API behaves ----
const me = await call("GET", appUrl, "/api/me");
check(me.status === 401 && typeof me.json?.error === "string", "Not signed in means 401 with a plain message", `HTTP ${me.status}`);
const nope = await call("GET", appUrl, "/api/nope");
check(nope.status === 404 && typeof nope.json?.error === "string", "Unknown API paths answer in JSON", `HTTP ${nope.status}`);
const evil = await call("POST", appUrl, "/api/demo/login", { body: {}, headers: { origin: "https://evil.example" } });
check(evil.status === 403, "A request that claims to come from another site is refused", `HTTP ${evil.status}`);
const forged = await call("POST", appUrl, "/api/paypal/webhook", { body: { id: "WH-CLOUD-CHECK", event_type: "PAYMENT.CAPTURE.REFUNDED", resource: {} }, headers: { "paypal-transmission-sig": "forged" } });
check(forged.status === 401, "A forged PayPal webhook is refused", `HTTP ${forged.status}`);
const timings: number[] = [];
for (let i = 0; i < 10; i++) timings.push((await call("GET", appUrl, "/api/me")).ms);
timings.sort((a, b) => a - b);
report("NOTE", "Speed of a simple request, 10 tries", `fastest ${timings[0]} ms, middle ${timings[5]} ms, slowest ${timings[9]} ms`);

// ---- 3. which address the app thinks you have ----
if (!diagToken) {
  report("SKIP", "Which address the app sees (decides TRUSTED_PROXY_HOPS)", "Set DIAG_TOKEN to the app's value from the Render dashboard and run again. This one matters: if it is wrong, every visitor shares one daily limit.");
} else {
  let mine = "";
  try {
    mine = ipBucket((await (await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(8000) })).text()).trim());
  } catch {
    mine = "";
  }
  const diag = await call("GET", appUrl, "/api/diag/ip", { headers: { "x-diag-token": diagToken } });
  if (diag.status !== 200) {
    report("FAIL", "Which address the app sees", `The diagnostic answered HTTP ${diag.status}. Check that DIAG_TOKEN here matches the one in Render.`);
  } else if (!mine || mine === "unknown") {
    report("SKIP", "Which address the app sees", `Could not find your own public address to compare with. The app saw: ${JSON.stringify(diag.json)}`);
  } else {
    const d = diag.json;
    const right = Object.entries(d.ifHopsWere as Record<string, string>).filter(([, v]) => v === mine).map(([k]) => k);
    if (d.countedAs === mine) {
      check(true, "Every visitor is counted under their own address", `TRUSTED_PROXY_HOPS=${d.trustedProxyHops} counts you as ${d.countedAs}, which is your address. Header seen: ${d.xForwardedFor}`);
    } else if (right.length > 0) {
      check(false, "Every visitor is counted under their own address", `NOT YET. The app counts you as ${d.countedAs}, but your address is ${mine}.\nSet TRUSTED_PROXY_HOPS=${right[0]} in the Render dashboard (the app > Environment), let it redeploy, and run this again.\nHeader seen: ${d.xForwardedFor}; entries: ${d.entriesInHeader}`);
    } else {
      check(false, "Every visitor is counted under their own address", `No setting finds your address (${mine}).\nThe app saw: socket ${d.socketAddress}, X-Forwarded-For ${d.xForwardedFor}, others ${JSON.stringify(d.otherHeaders)}.\nShare this output so the right header can be chosen.`);
    }
  }
}

// ---- 4. the shops, which are part of the app ----
for (const url of shopUrls) {
  try {
    const health = await call("GET", url, "/health", { timeoutMs: 120_000 });
    const search = await call("GET", url, "/search?q=kit");
    check(health.status === 200 && search.status === 200 && /result/.test(search.text), `Shop answers: ${url.replace(/^https?:\/\//, "")}`, `health ${health.status} in ${health.ms} ms, search HTTP ${search.status}`);
  } catch (err) {
    report("FAIL", `Shop answers: ${url}`, err instanceof Error ? err.message : String(err));
  }
}

// ---- 5. the full flow, only in mock mode ----
async function fullFlow(): Promise<void> {
  const login = await call("POST", appUrl, "/api/demo/login", { body: {} });
  if (login.status === 429) {
    report("SKIP", "Full purchase flow", `The sign-up limit for your address was reached (${login.json?.error}). Try again tomorrow, or from another network.`);
    return;
  }
  if (!check(login.status === 200, "Demo sign-in works", `HTTP ${login.status}`)) return;
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).find((c) => c?.startsWith("sid=")) ?? "";
  const setCookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.startsWith("sid=")) ?? "";
  check(/HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie) && (!/^https:/.test(appUrl) || /Secure/i.test(setCookie)), "The sign-in cookie is HttpOnly, SameSite and Secure", setCookie.replace(/sid=[^;]+/, "sid=…"));

  const state = await call("GET", appUrl, "/api/me", { cookie });
  if (!state.json?.mock) {
    report("SKIP", "Full purchase flow", "The app is not in mock mode, so a run would use the real Claude model and PayPal. Nothing was spent.");
    return;
  }
  report("NOTE", "The app is in mock mode", "A scripted shopper and a pretend PayPal. Nothing here costs money.");

  const created = await call("POST", appUrl, "/api/requests", { cookie, body: { item: "Wireless earbuds", condition: "new", maxPriceCents: 10000, askAboveCents: 10000, deadline: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10), sellerMinScore: 70, neverBuy: ["gift cards"] } });
  if (!check(created.status === 201, "A request can be made", `HTTP ${created.status}`)) return;
  const run = await call("POST", appUrl, "/api/requests/" + created.json.id + "/run", { cookie, body: {}, timeoutMs: 120_000 });
  const bought = run.status === 200 && run.json?.stage === "purchase" && run.json?.result?.status === "paid_out";
  check(bought, "The shopper reads the shops over the private network, the guard checks, and the purchase completes", `HTTP ${run.status} in ${run.ms} ms. ${bought ? "" : JSON.stringify(run.json).slice(0, 400)}`);
  if (!bought) return;
  check((run.json.rejections ?? []).some((r: any) => r.shopId === "deal-zone"), "The scam shop was turned down", JSON.stringify(run.json.rejections));
  const orders = await call("GET", appUrl, "/api/orders", { cookie });
  check(orders.json?.orders?.length === 1 && orders.json.orders[0].status === "paid_out" && orders.json.orders[0].shopStatus === "received", "The shop received the order", JSON.stringify(orders.json?.orders?.[0] ?? null).slice(0, 300));

  // The owner's control panel: the shop drops its price and ships the wrong item, then the owner presses refund.
  if (!controlToken) {
    report("SKIP", "Price drop, wrong item and refund", "Set CONTROL_TOKEN (the app's, from Render's Environment tab) to test this.");
    return;
  }
  const orderId: string = orders.json.orders[0].id;
  try {
    const drop = await call("POST", controlUrl, "/price", { form: { token: controlToken, shopId: "northgear", pct: "-15" }, timeoutMs: 120_000 });
    const wrong = await call("POST", controlUrl, "/ship-wrong", { form: { token: controlToken, orderId } });
    check(drop.status === 303 && wrong.status === 303, "The control panel works", `price ${drop.status}, ship wrong item ${wrong.status}. (303 means done.)`);
    const found = await call("POST", appUrl, "/api/aftercare/check", { cookie, body: {}, timeoutMs: 60_000 });
    const kinds = (found.json?.cases ?? []).map((c: any) => `${c.kind}:${c.status}:${c.amountCents}`).sort();
    check(kinds.join(",") === "price_drop:open:600,wrong_item:open:4500", "Both problems are found, with the right amounts", kinds.join(", "));
    const dropCase = (found.json?.cases ?? []).find((c: any) => c.kind === "price_drop");
    if (dropCase) {
      const refund = await call("POST", appUrl, `/api/cases/${dropCase.id}/refund`, { cookie, body: {} });
      check(refund.json?.result?.status === "refunded" && refund.json.result.amountCents === 600, "The refund is made for exactly the difference", JSON.stringify(refund.json?.result));
      const again = await call("POST", appUrl, `/api/cases/${dropCase.id}/refund`, { cookie, body: {} });
      check(again.status === 409, "Pressing again refunds nothing more", `HTTP ${again.status}`);
    }
  } finally {
    await call("POST", controlUrl, "/price", { form: { token: controlToken, shopId: "northgear", pct: "0" } }).catch(() => undefined);
  }
}
try {
  await fullFlow();
} catch (err) {
  report("FAIL", "Full purchase flow", err instanceof Error ? err.message : String(err));
}

// ---- 6. the live stream, after everything above has had a chance to appear on it ----
const remaining = STREAM_MS - (stream.info().ranMs + 0);
if (remaining > 0) await sleep(Math.min(remaining, STREAM_MS) + 500);
await stream.done;
const sse = stream.info();
const names = stream.events.map((e) => e.name);
const pings = stream.events.filter((e) => e.name === "ping");
const ready = stream.events.find((e) => e.name === "ready");
check(sse.status === 200, "The live stream opens", `HTTP ${sse.status}, headers after ${sse.headersMs} ms${sse.contentEncoding ? `, content-encoding ${sse.contentEncoding}` : ""}`);
check(!!ready && ready.at < 15_000, "The first events arrive at once, not held back by the proxy", ready ? `"ready" after ${ready.at} ms` : `no "ready" event in ${sse.ranMs} ms (saw: ${names.join(", ") || "nothing"})`);
const gaps = pings.map((p, i) => p.at - (i === 0 ? 0 : pings[i - 1]!.at)).slice(1);
const expectedPings = Math.floor((STREAM_MS - 5_000) / 20_000);
check(pings.length >= expectedPings && gaps.every((g) => g < 35_000), "Keep-alive pings keep arriving about every 20 seconds, so the connection stays open", `${pings.length} pings in ${Math.round(sse.ranMs / 1000)} s (wanted at least ${expectedPings}); gaps ${gaps.map((g) => `${Math.round(g / 1000)}s`).join(", ") || "n/a"}`);
const sawRun = stream.events.some((e) => e.data?.event?.type === "end");
if (results.some((r) => r.name.startsWith("The shopper reads the shops") && r.status === "PASS")) {
  check(sawRun, "The purchase appeared live in the Town square stream", sawRun ? "" : "The run finished but nothing came through the stream. The proxy may be buffering it.");
} else {
  report("SKIP", "The purchase appeared live in the Town square stream", "There was no purchase to watch for.");
}

// ---- summary ----
const count = (s: string): number => results.filter((r) => r.status === s).length;
console.log(`\n${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped.`);
if (count("FAIL") > 0) {
  console.log("Failed:");
  for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  - ${r.name}`);
}
process.exit(count("FAIL") > 0 ? 1 : 0);
