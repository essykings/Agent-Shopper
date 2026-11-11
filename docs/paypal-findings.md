# PayPal docs check (2026-11-11)

What the PayPal developer docs say about the questions that shape the payment service. "Docs silent" means we must test it in sandbox.

## 1. Charging a saved PayPal account later (buyer not present)
- **Yes.** Save PayPal with a setup token (`POST /v3/vault/setup-tokens`, `usage_type: MERCHANT`, `customer_type: CONSUMER`), and the buyer approves a billing agreement. Later: `POST /v2/checkout/orders` with `payment_source.paypal.vault_id`, and no buyer approval step.
  Source: https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/
- The Orders schema shows an AUTHORIZE example with `vault_id` and `stored_credential` (`payment_initiator: MERCHANT`), so authorize, re-check, then capture fits.
- Live needs PayPal to approve billing agreements / reference transactions ("Contact your account manager"). Sandbox: not stated, so test it.
- The docs warn "Don't save PayPal as a payment method during purchase", so we save PayPal at setup, before any purchase (the purchase-later flow). That matches step 1.

## 2. Paying different shops from one saved method (payee)
- **Docs silent.** No page shows a vaulted token used with `purchase_units[].payee` set to a different merchant.
- Platform (multiparty) APIs are for approved partners in live, but "you can call and test ... with your sandbox credentials before you are approved."
  Source: https://developer.paypal.com/platforms/get-started/
- **Decide by one sandbox test** (first build task): vault the buyer on the platform app, then create an order with `vault_id` plus `payee.email_address` set to a demo shop's sandbox business account.

## 3. Log in with PayPal
- Current (page updated Oct 2026) and works in sandbox with no review. Live review takes weeks.
- Scopes: `openid profile email address` give name, email and address.
  Sources: https://developer.paypal.com/log-in/build/, https://developer.paypal.com/log-in/references/
- **It's a separate flow from vaulting.** No combined approval is documented, so onboarding is two PayPal screens back to back: log in, then "save PayPal for your agent".

## 4. Disputes
- **A buyer can't open a dispute by API.** The Customer Disputes API has no create endpoint; it acts on existing disputes (evidence, offers, messages, accept claim, escalate).
  Source: https://developer.paypal.com/api/customer-disputes/v1/
- Sandbox-only endpoints `adjudicate` and `require-evidence` move an existing dispute's state, which is useful for the demo shops.
- How a sandbox buyer opens a dispute isn't stated (probably the sandbox Resolution Center, so test it).
- **Design:** the aftercare agent builds the evidence pack and hands the buyer to PayPal to file. The demo shop (a merchant) receives `CUSTOMER.DISPUTE.CREATED` and responds by API.

## 5. Authorizations, captures, refunds
- An authorization is valid for 30 days (from the webhook page). Honor period: not found.
- Partial captures: `final_capture: false` allows more captures. No limit stated.
- **Partial refunds work:** `POST /v2/payments/captures/{id}/refund` with an `amount` covers the price-drop refund.
  Sources: https://developer.paypal.com/api/payments/v2/authorizations-capture/, https://developer.paypal.com/api/payments/v2/captures-refund/

## 6. Webhooks we need
`PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.REFUNDED`, `CUSTOMER.DISPUTE.CREATED`, `CUSTOMER.DISPUTE.UPDATED`, `CUSTOMER.DISPUTE.RESOLVED`, `VAULT.PAYMENT-TOKEN.CREATED`, `VAULT.PAYMENT-TOKEN.DELETED`.
Source: https://developer.paypal.com/api/rest/webhooks/event-names/

## 7. Sandbox test results (2026-11-11, scripts/payee-test.ts)
- **Verified in sandbox:** the app saved a buyer's PayPal (Vault must be ticked under the app's "Save payment methods" feature, otherwise 403 NOT_AUTHORIZED), then charged it with no buyer present: create order with `vault_id`, authorize, capture. Test A: COMPLETED, paid to our own business account.
- **Verified in sandbox:** setting `payee.email_address` to a different business account fails with `422 BILLING_AGREEMENT_NOT_FOUND`. The saved PayPal is tied to the merchant that saved it, so one saved PayPal cannot pay other shops directly.
- Not yet tested: platform (partner) calls with the shop as payee, and paying shops through Payouts.

## 8. Valid rerun on US sandbox accounts (2026-11-11)
- Both accounts US, app and shop on different business accounts. Test A: COMPLETED. Test B (payee = a different US business account): `422 BILLING_AGREEMENT_NOT_FOUND`, same as the Kenyan accounts, so the country is not the cause.
- An earlier "pass" was invalid: SHOP_PAYEE_EMAIL was the app's own account. The script now flags that case and rejects a malformed email.
- Conclusion: a PayPal saved by our app can only pay our own app's account. Next: test the partner route (shop onboarded under our app) and the Payouts route.

## 9. Partner route and Payouts (2026-11-11)
- **Partner onboarding works in sandbox.** A Platform-type app created a seller sign-up link; a demo shop (US business account) signed in and agreed. Result: `permissionsGranted=true`, `accountStatus=BUSINESS_ACCOUNT`, `riskStatus=SUBSCRIBED_WITH_ALL_FEATURES`, merchant id returned (`merchantIdInPayPal`).
- **Platform-level saving of a buyer's PayPal is blocked for our Platform app:** `403 NOT_ENABLED_TO_VAULT_PAYMENT_SOURCE` on POST /v3/vault/setup-tokens (usage_type PLATFORM), and plain `NOT_AUTHORIZED` when retried with the seller assertion header. Needs the Platform app's features checked, or PayPal to enable it. The charge-to-seller step (scripts/partner-charge.ts) has not run.
- **Payouts works in sandbox (verified by API status):** $5.00 from our app's business account to the demo shop's email, batch SUCCESS, item SUCCESS. Checked through the Payouts API, not by looking at the shop's balance.
- Working route today: buyer's saved PayPal -> our app (payee-test Test A) -> Payouts -> shop. Our app is the merchant of record.

## 10. Payment service verified end to end in sandbox (2026-11-11)
- `scripts/payment-smoke.ts` ran the real payment service once: guard -> hold $5.00 on the saved buyer PayPal (authorization CREATED) -> guard again with a fresh price -> capture (COMPLETED) -> Payouts to the demo shop (batch SUCCESS, item SUCCESS). Order row `paid_out`; ledger: set_aside, guard_allow, payment_captured, payout_sent.
- Checked through PayPal's API statuses, not by looking at the shop's sandbox balance.
- Not covered yet: webhooks (a crash after PayPal takes the money but before we record it), refunds, and disputes.

## 11. Refunds and webhook checks, from PayPal's docs (2026-11-11; read, not yet run)
Read on developer.paypal.com. Nothing here has been run against the sandbox yet.
- **Refund** `POST /v2/payments/captures/{capture_id}/refund`. Body (all optional): `amount {currency_code, value}`, `custom_id` (1-127), `invoice_id` (1-127), `note_to_payer` (1-255), `payment_instruction` (marketplaces only). "For a full refund, include an empty payload"; for a partial refund include `amount`. Headers: `PayPal-Request-Id` (idempotency; a repeat answers 200, a new refund 201), `Prefer: return=representation`.
- Response example shows `id`, `amount`, `invoice_id`, `custom_id`, `status` (COMPLETED seen), `links` incl. rel `up` to the capture. **Not seen on the pages:** the full list of `status` values (we treat COMPLETED as done, PENDING as pending, anything else as failed), and any refund time limit.
- A refund fails with 422 when the amount is more than what is left unrefunded, and **when there is an open case (dispute) on the payment**. The aftercare code must expect that failure and say so plainly.
- **Webhook check** `POST /v1/notifications/verify-webhook-signature` with `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig`, `transmission_time` (all from the `PAYPAL-*` headers), `webhook_id`, and `webhook_event`. The response has `verification_status: "SUCCESS"` (a failure value was not shown, so anything else is a failure). **The event must be posted back exactly as received**; parsing and re-serialising can fail the check. Mock events from the webhook simulator cannot be verified this way.
- A `webhook_id` comes from the developer dashboard (app settings) or `POST /v1/notifications/webhooks`. Webhooks go to a public **HTTPS port 443** address; failures are retried up to 25 times over 3 days. Local development needs a public tunnel.
- **Unverified:** the fields inside `CUSTOMER.DISPUTE.*` events and inside the `PAYMENT.CAPTURE.REFUNDED` resource (whether it carries our `custom_id`). The aftercare code reads them defensively and must be checked against a real payload.

## 12. One real refund in the sandbox (2026-11-11, scripts/refund-live.ts)
Ran once, against the sandbox, through the real aftercare code. Checked by asking PayPal's API directly, not only our own records.
- **Verified:** a partial refund works. A $45.00 capture (saved buyer PayPal, authorize then capture) was refunded $6.00 with `POST /v2/payments/captures/{id}/refund` and an explicit `amount`. PayPal answered with a refund whose `status` was **COMPLETED** straight away (not PENDING).
- **Verified:** the refund, read back with `GET /v2/payments/refunds/{id}`, shows `amount` 6.00 USD, our `custom_id` (the case id) and our `note_to_payer`. So `custom_id` is stored on the refund. **Still unverified:** whether the `PAYMENT.CAPTURE.REFUNDED` webhook carries it.
- **Verified:** after the refund, `GET /v2/payments/captures/{id}` reports status **PARTIALLY_REFUNDED**. The `seller_receivable_breakdown.total_refunded_amount` field was not shown in that response, so do not rely on it; use the refund records instead.
- Not tested: the repeat-safe request id (a second call with the same `PayPal-Request-Id`), refunding while a dispute is open, any refund time limit, and webhooks (they need a public https address).
- Cost: one sandbox payment of $45.00 and one refund of $6.00. No payout was made.
