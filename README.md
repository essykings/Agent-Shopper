# Agent Shopper

**An AI agent that shops for you with PayPal, where plain code, not the AI, decides whether any money moves.**

You tell it what to buy in plain words ("wireless earbuds", "something to keep my phone charged on a long hike") and the most you will pay. The agent browses three shops, avoids the scam shop, and proposes a purchase. A rules engine (the *guard*, ordinary code with no model in it) then checks the proposal and decides: allow, ask you first, or refuse. Only then does PayPal move money. After the purchase, the app keeps watching: if a shop lowers its price, you are refunded the difference automatically, and when the order is delivered you are asked to confirm it arrived.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Everything uses the **PayPal sandbox**: no real money moves.

## What is real and what is simulated

| Real | Simulated |
|---|---|
| PayPal sandbox: saved-account charges (Vault), authorize and capture, Payouts to shops, refunds, webhook verification | The three shops (Northgear, Deal-Zone, Trailhead). They are small websites in this repo, about 100 products each. Nobody ships anything. |
| Claude (Haiku 5.5) driving the shopper, reading shop pages as text and links, exactly as a browsing agent would | The scam: Deal-Zone has a new domain, copied five-star reviews, prices far too low, and hidden text aimed at AI readers |
| A guard, a payment service, an append-only ledger and per-address abuse limits | Shop events: orders ship and are delivered on their own timeline (shipped within hours, delivered in one to two days). In the demo, one shop cuts the price of a demo account's first order about a minute after it is placed, so the automatic refund can be seen. The owner's control panel can also change a shop's price or make a shop ship the wrong item |

## How it works

```
 your request ──▶ shopper agent (Claude) ──▶ proposal ──▶ GUARD (plain code) ──▶ payment service ──▶ PayPal
                      │  reads shop pages          │  allow / ask you / refuse      │  hold, re-check, capture,
                      │  checks the seller         │  checks every claim against    │  pay the shop, ledger entry
                      ▼  cannot spend              ▼  the saved page text           ▼
                 live map (Playground / Town square)                       aftercare: price drop refunded     
                                                                           automatically, delivery check  
```

- **The agent proposes; the guard decides.** The agent never touches money. Price, arrival date, category and seller score on a proposal are read from the saved page by code, not given by the model. Quotes it relies on must appear on the saved page. "New" claims need new, sealed or unopened wording and no used or refurbished words.
- **Two guard passes.** The guard runs when the proposal is made and again with a fresh price just before the money is taken. If the price rose, nothing is charged.
- **Prompt-injection defence.** Page text is untrusted. Hidden text aimed at AI readers is detected and lowers the shop's score, and the agent is told never to follow instructions found in a page.
- **Safe by default.** An unknown shop is refused. A guard that cannot decide says "ask", never "allow". Money is whole cents. The ledger cannot be edited (database triggers). One live order per request is enforced by the database.
- **Gifts.** The agent and the API also accept a request that is a goal instead of an item. The agent then suggests up to three gifts with reasons, every hard rule still applies, and the guard always asks you to choose. The new-request screen currently offers a single item only.
- **Aftercare.** After a purchase the app keeps checking the shop's price. If the shop lowers it inside its price-protection window (14 days in the demo shops), the difference is refunded automatically, without a button, because a price on a shop's page is a fact the code can check. The refund can never exceed what is left of the payment. If an automatic refund fails it is tried again a few times, then left for you to press the button, and a notification tells you what happened either way (`AUTO_REFUND=0` turns automatic refunds off). When an order is delivered, the app asks you, in neutral words, to confirm it arrived as ordered. A refund for a delivery problem follows only if you report a problem and the shop's own delivery record agrees.
- **Live view.** The *Playground* shows your agent walking between shops, the guard and PayPal as it works. The public *Town square* shows every shopper anonymously: no typed text and no guard reasons are shown, and your own agents carry a "You" label for you alone.

## Tools used

- **PayPal** sandbox APIs: Vault (saved buyer, including "Use my own sandbox account", where the person signs in on PayPal's own page), Orders (authorize, capture), Payouts, Payments refunds, Webhooks (signature verification; not yet connected on the live site).
- **Claude Haiku 5.5** (`claude-haiku-5-5`) through the Anthropic SDK, with strict tool use. It is the shopper and the writer of case messages. It never decides money.
- **Sponsor tools:** **Render** hosts the app and its Postgres database (see below), and **AG Grid** draws the ledger table on the Wallet page. No other sponsor tool is used.
- Hono, React, Vite, TypeScript (Node 24 type stripping), Server-Sent Events for the live map, `node:test`.

## Run it yourself (no keys, no cost)

Needs Node 24.22.1 (see `.nvmrc`) and Docker for Postgres.

```bash
npm ci
docker compose up -d                 # Postgres on 127.0.0.1:54329. If your Docker has no `compose`, use:
# docker run -d --name agent-shopper-db -e POSTGRES_USER=shopper -e POSTGRES_PASSWORD=shopper -e POSTGRES_DB=agent_shopper -p 127.0.0.1:54329:5432 postgres:15
cp .env.example .env                 # the local DATABASE_URL in it already matches
npm run web:build                    # builds the screens
npm run app:mock                     # the app on http://localhost:3000, with the three shops at /shops/<name> and the control panel at /control
```

Open http://localhost:3000 and press **Try the demo**. **Mock mode** uses a scripted shopper and a pretend PayPal, so the whole experience runs without any account or cost. Try:

1. *New request*: "Wireless earbuds" and a price. The shopper starts at once; watch the map turn Deal-Zone down.
2. Wait about a minute. In the demo, the shop cuts the price of your first order, and the shopper refunds the difference automatically. The message at the top of the page opens your notifications (the bell). The wait is `DEMO_EVENT_SECONDS` (default 60; 0 turns the scripted events off). Orders ship after about 6 hours and arrive after 24 to 48 hours, and then you are asked to confirm the delivery. To see that without waiting, set `SHIP_AFTER_HOURS=0 DELIVER_MIN_HOURS=0 DELIVER_MAX_HOURS=0` (or press **Deliver** for the order in the control panel).
3. Or make it happen yourself: open the control panel (http://localhost:3000/control/), press **Drop 15%** for a shop, and your next check refunds the difference.
4. Open http://localhost:3000/#/town in a second tab to see the public view.

### With the real Claude model and the PayPal sandbox

Add `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `VAULT_ID` (or `DEMO_VAULT_ID`) and `SHOP_PAYEE_EMAIL` to `.env` (`.env.example` says where each comes from), then `npm run app`. A real run uses a little Anthropic credit (an early estimate was 0.2 to 2 US cents; it has not been re-measured) and, if the shopper buys something, a payment in the PayPal sandbox. The scripts in `scripts/` that spend money say so at the top.

## Tests

```bash
npm test            # 308 tests, about 15 seconds, no keys and no cost (needs the local Postgres)
npm run typecheck && npm run web:typecheck
```

The model is scripted in tests, so they check everything around it: the tools, the guard, injection handling, limits, payments, refunds, webhooks and the live feeds. The real PayPal client is tested against a local stand-in server that checks the exact requests it sends. Real sandbox runs are recorded, with what they showed and what they did not, in `docs/paypal-findings.md`.

## Deploy on Render

`render.yaml` is a Blueprint: one web service (the app, which also serves the three simulated shops at `/shops/<name>` and the owner's control panel at `/control`) and a Postgres database. That is about $13 a month, as Render's pricing page showed on 2026-11-11. The Blueprint no longer sets `MOCK_SERVICES`, so the app starts in **real mode** and needs the keys listed below. To deploy and test in the cloud at no model or PayPal cost, add `MOCK_SERVICES=1` in the dashboard (a scripted shopper and a pretend PayPal). After it is up, `scripts/cloud-check.ts` tests the live address (reachability, the live stream through Render's proxy, which address the app sees, and, in mock mode only, a full purchase and refund):

```bash
DIAG_TOKEN=... CONTROL_TOKEN=... node scripts/cloud-check.ts https://<app>.onrender.com
```

**Going live** is adding settings in the Render dashboard (the app's Environment tab), then redeploying, with `MOCK_SERVICES` absent: `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_VAULT_ID`, `SHOP_PAYEE_EMAIL`, and `PAYPAL_WEBHOOK_ID` once a webhook pointing at `https://<app>/api/paypal/webhook` exists in the PayPal developer dashboard. `TRUSTED_PROXY_HOPS` is set to 2 in `render.yaml`, which is what the cloud check measured on Render (the header arrives as the visitor's address followed by a Cloudflare address). Re-run the check if you move hosts, or every visitor could share one daily limit. The demo's daily limits per address (`LIMIT_IP_SIGNUPS_PER_DAY`, default 5, and `LIMIT_IP_RUNS_PER_DAY`, default 10) are low on purpose; raise them while many people try it, and lower them again afterwards so the model budget cannot run away.

## Project layout

| Path | What |
|---|---|
| `src/server/` | the guard, payment service, ledger, PayPal client, refunds, webhooks, abuse limits |
| `src/agent/` | the shopper agent, page reader, seller scoring |
| `src/shops/` | the three simulated shops and the control panel (mounted by the app at `/shops/<name>` and `/control`) |
| `src/app/` | the web app's API, the scripted mock shopper, the live-feed hub |
| `src/shared/` | types and the live-view logic shared with the screens |
| `web/` | the React screens |
| `db/migrations/` | the database schema, applied automatically on start |
| `scripts/` | sandbox and live checks. Anything that spends money says so at the top. |
| `docs/paypal-findings.md` | what PayPal's docs say and what the sandbox actually did |

## License

MIT. See `LICENSE`.
