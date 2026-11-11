# Agent Shopper

**An AI agent that shops for you with PayPal, where plain code, not the AI, decides whether any money moves.**

You tell it what to buy ("wireless earbuds", "a Christmas gift for Dad who likes hiking") and set the rules: a price limit, a deadline, a minimum shop trust score, categories it must never buy. The agent browses shops, avoids the scam shop, and proposes a purchase. A rules engine (the *guard*, ordinary code with no model in it) then checks the proposal and decides: allow, ask you first, or refuse. Only then does PayPal move money. After the purchase, the app watches for problems (a price drop, the wrong item) and builds the case for a refund, which you approve with one press.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Everything uses the **PayPal sandbox**: no real money moves.

## What is real and what is simulated

| Real | Simulated |
|---|---|
| PayPal sandbox: saved-account charges (Vault), authorize and capture, Payouts to shops, refunds, webhook verification | The three shops (Northgear, Deal-Zone, Trailhead). They are small websites in this repo, about 100 products each. Nobody ships anything. |
| Claude (Haiku 5.5) driving the shopper, reading shop pages as text and links, exactly as a browsing agent would | The scam: Deal-Zone has a new domain, copied five-star reviews, prices far too low, and hidden text aimed at AI readers |
| A guard, a payment service, an append-only ledger and per-address abuse limits | "What arrived": in the demo, the shop's delivery record says what it shipped, and the owner's control panel makes a shop ship the wrong item or change its price |

## How it works

```
 your request ──▶ shopper agent (Claude) ──▶ proposal ──▶ GUARD (plain code) ──▶ payment service ──▶ PayPal
                      │  reads shop pages          │  allow / ask you / refuse      │  hold, re-check, capture,
                      │  checks the seller         │  checks every claim against    │  pay the shop, ledger entry
                      ▼  cannot spend              ▼  the saved page text           ▼
                 live map (Playground / Town square)                       aftercare: price drop, wrong item,
                                                                           evidence pack, refund you approve
```

- **The agent proposes; the guard decides.** The agent never touches money. Price, arrival date, category and seller score on a proposal are read from the saved page by code, not given by the model. Quotes it relies on must appear on the saved page. "New" claims need new, sealed or unopened wording and no used or refurbished words.
- **Two guard passes.** The guard runs when the proposal is made and again with a fresh price just before the money is taken. If the price rose, nothing is charged.
- **Prompt-injection defence.** Page text is untrusted. Hidden text aimed at AI readers is detected and lowers the shop's score, and the agent is told never to follow instructions found in a page.
- **Safe by default.** An unknown shop is refused. A guard that cannot decide says "ask", never "allow". Money is whole cents. The ledger cannot be edited (database triggers). One live order per request is enforced by the database.
- **Gifts.** A request can be a goal instead of an item. The agent suggests up to three gifts with reasons, every hard rule still applies, and the guard always asks you to choose.
- **Aftercare.** The app finds a price drop inside a shop's price-protection window or a wrong item, collects an evidence pack (the listing as saved with a fingerprint, the order, the delivery record, the shop's policy, a timeline), has the shopper draft a message, and refunds only when you press the button. The amount is worked out again at that moment and can never exceed what is left of the payment.
- **Live view.** The *Playground* shows your agent walking between shops, the guard and PayPal as it works. The public *Town square* shows every shopper anonymously: no typed text and no guard reasons are shown, and your own agents carry a "You" label for you alone.
- **Abuse limits for a public demo.** Per-address and per-account daily limits on runs, sign-ups and purchases, a cap on concurrent runs, a daily model budget counted before each run starts, a token cap per run, and a kill switch.

## Tools used

- **PayPal** sandbox APIs: Vault (saved buyer, including "connect your own sandbox account"), Orders (authorize, capture), Payouts, Payments refunds, Webhooks (signature verification).
- **Claude Haiku 5.5** (`claude-haiku-5-5`) through the Anthropic SDK, with strict tool use. It is the shopper and the writer of case messages. It never decides money.
- **AG Grid** for the ledger table on the Wallet page.
- **Render** to host it (see below), and Postgres for state.
- Hono, React, Vite, TypeScript (Node 24 type stripping), `node:test`.

## Run it yourself (no keys, no cost)

Needs Node 24.22.1 (see `.nvmrc`) and Docker for Postgres.

```bash
npm ci
docker compose up -d                 # Postgres on 127.0.0.1:54329. If your Docker has no `compose`, use:
# docker run -d --name agent-shopper-db -e POSTGRES_USER=shopper -e POSTGRES_PASSWORD=shopper -e POSTGRES_DB=agent_shopper -p 127.0.0.1:54329:5432 postgres:15
cp .env.example .env                 # the local DATABASE_URL in it already matches
npm run web:build                    # builds the screens
npm run shops:local                  # the three shops (ports 4101-4103) and the control panel (4100)
npm run app:mock                     # in a second terminal: the app on http://localhost:3000
```

Open http://localhost:3000 and press **Try the demo**. **Mock mode** uses a scripted shopper and a pretend PayPal, so the whole experience runs without any account or cost. Try:

1. *New request*: "Wireless earbuds". Run it in the **Playground** and watch the guard turn Deal-Zone down.
2. *New request* > **A gift or an occasion**: "Dad, Christmas, likes hiking and coffee".
3. Open the control panel (http://localhost:4100), press **Drop 15%** for Northgear, then open **Orders** and press **Check for problems**.
4. Open http://localhost:3000/#/town in a second tab to see the public view.

### With the real Claude model and the PayPal sandbox

Add `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `VAULT_ID` (or `DEMO_VAULT_ID`) and `SHOP_PAYEE_EMAIL` to `.env` (`.env.example` says where each comes from), then `npm run app`. A real run costs about 0.2 to 2 US cents of Anthropic usage and buys nothing until you approve; the scripts in `scripts/` that spend money say so at the top.

## Tests

```bash
npm test            # 235 tests, about 5 seconds, no keys and no cost (needs the local Postgres)
npm run typecheck && npm run web:typecheck
```

The model is scripted in tests, so they check everything around it: the tools, the guard, injection handling, limits, payments, refunds, webhooks and the live feeds. The real PayPal client is tested against a local stand-in server that checks the exact requests it sends. Real sandbox runs are recorded, with what they showed and what they did not, in `docs/paypal-findings.md`.

## Deploy on Render

`render.yaml` is a Blueprint: the app, three shop sites, the owner's control panel and a Postgres database, all in one region. It starts in **mock mode** so deploying and testing in the cloud costs no model or PayPal money. After it is up, `scripts/cloud-check.ts` tests the live address (reachability, the live stream through Render's proxy, which address the app sees, and a full purchase and refund in mock mode):

```bash
DIAG_TOKEN=... CONTROL_TOKEN=... node scripts/cloud-check.ts https://<app>.onrender.com --control https://<control>.onrender.com
```

**Going live** is adding settings in the Render dashboard (the app's Environment tab), then redeploying: `MOCK_SERVICES` removed, plus `ANTHROPIC_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DEMO_VAULT_ID`, `SHOP_PAYEE_EMAIL` (also on the three shops), and `PAYPAL_WEBHOOK_ID` once a webhook pointing at `https://<app>/api/paypal/webhook` exists in the PayPal developer dashboard. Set `TRUSTED_PROXY_HOPS` from what the cloud check reports, or every visitor shares one daily limit.

## Known limits and things not yet verified

- The shops are simulated. Prices are invented and do not match real-world prices.
- Shop search matches whole words only: "flashlight" does not find the headlamp.
- Verified in the sandbox: the charge, payout and a partial refund (checked through PayPal's API). **Not verified:** webhooks (they need a public https address), the fields inside PayPal's dispute events, a refund while a dispute is open, and whether PayPal's refund webhook carries our case id. The code reads those events defensively.
- A buyer cannot open a PayPal dispute through the API, so the app records disputes PayPal reports and supplies the evidence; it cannot file one.
- Render's forwarded-address behaviour and its limits on long-lived streams are not in its documentation and are measured by `scripts/cloud-check.ts`.
- The live (non-sandbox) PayPal environment would need PayPal's approval for vaulting and "Log in with PayPal". This project is a sandbox demo.

## Project layout

| Path | What |
|---|---|
| `src/server/` | the guard, payment service, ledger, PayPal client, refunds, webhooks, abuse limits |
| `src/agent/` | the shopper agent, page reader, seller scoring |
| `src/shops/` | the three simulated shops and the control panel |
| `src/app/` | the web app's API, the scripted mock shopper, the live-feed hub |
| `src/shared/` | types and the live-view logic shared with the screens |
| `web/` | the React screens |
| `db/migrations/` | the database schema, applied automatically on start |
| `scripts/` | sandbox and live checks. Anything that spends money says so at the top. |
| `docs/paypal-findings.md` | what PayPal's docs say and what the sandbox actually did |

## License

MIT. See `LICENSE`.
