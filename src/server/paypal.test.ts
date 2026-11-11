// Tests the real PayPal client against a small local stand-in server, so the exact requests
// it sends (headers, amounts, ids) can be checked without touching PayPal.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createPayPalClient, toAmount } from "./paypal.ts";
import { PayPalError } from "./paypal-port.ts";

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
interface Reply {
  status: number;
  json?: unknown;
  delayMs?: number;
  headers?: Record<string, string>;
}

async function stub(route: (req: Seen) => Reply) {
  const requests: Seen[] = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const isJson = String(req.headers["content-type"] ?? "").includes("json") && data;
      const seen: Seen = { method: req.method!, url: req.url!, headers: req.headers, body: isJson ? JSON.parse(data) : data };
      requests.push(seen);
      const out = route(seen);
      setTimeout(() => {
        res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
        res.end(out.json === undefined ? "" : JSON.stringify(out.json));
      }, out.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const goodRoute = (req: Seen): Reply => {
  if (req.url === "/v1/oauth2/token") return { status: 200, json: { access_token: "tok", expires_in: 3600 } };
  if (req.url === "/v2/checkout/orders") return { status: 201, json: { id: "O1", status: "CREATED", purchase_units: [{ payments: { authorizations: [{ id: "A1", status: "CREATED" }] } }] } };
  if (req.url === "/v2/payments/authorizations/A1/capture") return { status: 201, json: { id: "C1", status: "COMPLETED" } };
  if (req.url === "/v2/payments/authorizations/A1/void") return { status: 204 };
  if (req.url === "/v1/payments/payouts") return { status: 201, json: { batch_header: { payout_batch_id: "B1", batch_status: "PENDING" } } };
  if (req.url === "/v1/payments/payouts/B1") return { status: 200, json: { batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "SUCCESS" }] } };
  return { status: 404, json: { name: "NOT_FOUND", message: req.url } };
};

const client = (url: string, over = {}) =>
  createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: url, timeoutMs: 2000, payoutPollIntervalMs: 5, payoutPollCount: 3, ...over });

test("amounts are written as exact dollars and cents", () => {
  assert.equal(toAmount(27900), "279.00");
  assert.equal(toAmount(5), "0.05");
  assert.equal(toAmount(101), "1.01");
  assert.throws(() => toAmount(0));
  assert.throws(() => toAmount(12.5));
  assert.throws(() => toAmount(-100));
});

test("hold, take and pay the shop send the requests PayPal expects", async () => {
  const s = await stub(goodRoute);
  try {
    const pp = client(s.url);
    const held = await pp.authorizeSaved({ vaultId: "V1", amountCents: 27900, requestId: "auth-1", description: "PS5", customId: "order-1" });
    assert.deepEqual(held, { orderId: "O1", authorizationId: "A1" });
    assert.deepEqual(await pp.capture({ authorizationId: "A1", requestId: "cap-1" }), { captureId: "C1" });
    await pp.voidAuthorization({ authorizationId: "A1", requestId: "void-1" });
    const paid = await pp.payout({ receiverEmail: "shop@example.com", amountCents: 27900, batchId: "b1", note: "Order 1" });
    assert.equal(paid.status, "success");
    assert.equal(paid.payoutBatchId, "B1");

    const order = s.requests.find((r) => r.url === "/v2/checkout/orders")!;
    assert.equal(order.headers.authorization, "Bearer tok");
    assert.equal(order.headers["paypal-request-id"], "auth-1");
    assert.equal(order.body.intent, "AUTHORIZE");
    assert.equal(order.body.purchase_units[0].amount.value, "279.00");
    assert.equal(order.body.purchase_units[0].amount.currency_code, "USD");
    assert.equal(order.body.purchase_units[0].custom_id, "order-1");
    assert.equal(order.body.payment_source.paypal.vault_id, "V1");

    const capture = s.requests.find((r) => r.url.endsWith("/capture"))!;
    assert.equal(capture.body.final_capture, true);
    assert.equal(capture.headers["paypal-request-id"], "cap-1");

    const payout = s.requests.find((r) => r.url === "/v1/payments/payouts" && r.method === "POST")!;
    assert.equal(payout.body.sender_batch_header.sender_batch_id, "b1");
    assert.equal(payout.body.items[0].receiver, "shop@example.com");
    assert.equal(payout.body.items[0].amount.value, "279.00");
  } finally {
    await s.close();
  }
});

test("the access token is fetched once and reused", async () => {
  const s = await stub(goodRoute);
  try {
    const pp = client(s.url);
    await pp.authorizeSaved({ vaultId: "V1", amountCents: 100, requestId: "a", description: "x", customId: "o" });
    await pp.capture({ authorizationId: "A1", requestId: "c" });
    await pp.voidAuthorization({ authorizationId: "A1", requestId: "v" });
    assert.equal(s.requests.filter((r) => r.url === "/v1/oauth2/token").length, 1);
  } finally {
    await s.close();
  }
});

test("a PayPal refusal becomes an error that names the step, the reason and the debug id", async () => {
  const s = await stub((req) =>
    req.url === "/v1/oauth2/token"
      ? { status: 200, json: { access_token: "tok", expires_in: 3600 } }
      : { status: 422, headers: { "paypal-debug-id": "dbg123" }, json: { name: "UNPROCESSABLE_ENTITY", message: "Business validation failed", details: [{ issue: "BILLING_AGREEMENT_NOT_FOUND", description: "not found" }] } },
  );
  try {
    await assert.rejects(client(s.url).authorizeSaved({ vaultId: "V1", amountCents: 100, requestId: "a", description: "x", customId: "o" }), (err: unknown) => {
      assert.ok(err instanceof PayPalError);
      assert.equal(err.step, "Hold the money");
      assert.equal(err.status, 422);
      assert.equal(err.issue, "BILLING_AGREEMENT_NOT_FOUND");
      assert.equal(err.debugId, "dbg123");
      assert.match(err.message, /Hold the money failed/);
      return true;
    });
  } finally {
    await s.close();
  }
});

test("a call that never answers stops with the name of the step", async () => {
  const s = await stub(() => ({ status: 200, json: {}, delayMs: 1000 }));
  try {
    await assert.rejects(client(s.url, { timeoutMs: 100 }).capture({ authorizationId: "A1", requestId: "c" }), /Get access token failed: no answer after/);
  } finally {
    await s.close();
  }
});

test("a payment that is not completed is an error, not a success", async () => {
  const s = await stub((req) => (req.url.endsWith("/capture") ? { status: 201, json: { id: "C9", status: "PENDING" } } : goodRoute(req)));
  try {
    await assert.rejects(client(s.url).capture({ authorizationId: "A1", requestId: "c" }), /did not complete the payment \(status PENDING\)/);
  } finally {
    await s.close();
  }
});

test("a hold that PayPal did not place is an error", async () => {
  const s = await stub((req) =>
    req.url === "/v2/checkout/orders"
      ? { status: 201, json: { id: "O3", status: "CREATED", purchase_units: [{ payments: { authorizations: [{ id: "A3", status: "PENDING" }] } }] } }
      : goodRoute(req),
  );
  try {
    await assert.rejects(client(s.url).authorizeSaved({ vaultId: "V1", amountCents: 100, requestId: "a", description: "x", customId: "o" }), /did not place a hold/);
  } finally {
    await s.close();
  }
});

test("when PayPal does not return the hold with the order, the client asks for it", async () => {
  const s = await stub((req) => {
    if (req.url === "/v2/checkout/orders") return { status: 201, json: { id: "O2", status: "CREATED" } };
    if (req.url === "/v2/checkout/orders/O2/authorize") return { status: 201, json: { purchase_units: [{ payments: { authorizations: [{ id: "A2", status: "CREATED" }] } }] } };
    return goodRoute(req);
  });
  try {
    const held = await client(s.url).authorizeSaved({ vaultId: "V1", amountCents: 100, requestId: "a", description: "x", customId: "o" });
    assert.deepEqual(held, { orderId: "O2", authorizationId: "A2" });
    assert.ok(s.requests.some((r) => r.url === "/v2/checkout/orders/O2/authorize"));
  } finally {
    await s.close();
  }
});

test("a payout still processing is pending, and an unclaimed or denied one is failed", async () => {
  let mode: "pending" | "unclaimed" | "denied" = "pending";
  const s = await stub((req) => {
    if (req.url === "/v1/payments/payouts/B1") {
      if (mode === "pending") return { status: 200, json: { batch_header: { batch_status: "PROCESSING" }, items: [] } };
      if (mode === "unclaimed") return { status: 200, json: { batch_header: { batch_status: "SUCCESS" }, items: [{ transaction_status: "UNCLAIMED" }] } };
      return { status: 200, json: { batch_header: { batch_status: "DENIED" }, items: [{ transaction_status: "FAILED", errors: { name: "RECEIVER_UNREGISTERED", message: "No account" } }] } };
    }
    return goodRoute(req);
  });
  try {
    const pp = client(s.url);
    const input = { receiverEmail: "shop@example.com", amountCents: 100, batchId: "b", note: "n" };
    assert.equal((await pp.payout(input)).status, "pending");
    mode = "unclaimed";
    assert.equal((await pp.payout(input)).status, "failed");
    mode = "denied";
    const denied = await pp.payout(input);
    assert.equal(denied.status, "failed");
    assert.match(denied.detail ?? "", /RECEIVER_UNREGISTERED/);
  } finally {
    await s.close();
  }
});

// ---------- connecting a person's own PayPal account ----------

const APPROVE = "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=ST1";
const vaultRoute = (over: Record<string, (req: Seen) => Reply> = {}) => (req: Seen): Reply => {
  const custom = over[`${req.method} ${req.url}`];
  if (custom) return custom(req);
  if (req.url === "/v3/vault/setup-tokens" && req.method === "POST") return { status: 200, json: { id: "ST1", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "self", href: "https://x/self" }, { rel: "approve", href: APPROVE }] } };
  if (req.url === "/v3/vault/setup-tokens/ST1" && req.method === "GET") return { status: 200, json: { id: "ST1", status: "APPROVED" } };
  if (req.url === "/v3/vault/payment-tokens" && req.method === "POST") return { status: 200, json: { id: "PT1", payment_source: { paypal: { email_address: "buyer@example.com" } } } };
  if (req.url === "/v3/vault/payment-tokens/PT1" && req.method === "DELETE") return { status: 204 };
  return goodRoute(req);
};

test("starting a connection sends the right request and returns the link to send the person to", async () => {
  const s = await stub(vaultRoute());
  try {
    const out = await client(s.url).createVaultSetup({ returnUrl: "https://app.test/api/paypal/return", cancelUrl: "https://app.test/api/paypal/cancel", requestId: "setup-1" });
    assert.deepEqual(out, { setupTokenId: "ST1", approveUrl: APPROVE });
    const req = s.requests.find((r) => r.url === "/v3/vault/setup-tokens")!;
    assert.equal(req.headers["paypal-request-id"], "setup-1");
    const p = req.body.payment_source.paypal;
    assert.equal(p.usage_type, "MERCHANT");
    assert.equal(p.customer_type, "CONSUMER");
    assert.equal(p.permit_multiple_payment_tokens, false);
    assert.equal(p.experience_context.return_url, "https://app.test/api/paypal/return");
    assert.equal(p.experience_context.cancel_url, "https://app.test/api/paypal/cancel");
    assert.match(p.description, /Agent Shopper/);
  } finally {
    await s.close();
  }
});

test("a connection that comes back without an approval link is an error", async () => {
  const s = await stub(vaultRoute({ "POST /v3/vault/setup-tokens": () => ({ status: 200, json: { id: "ST1", links: [] } }) }));
  try {
    await assert.rejects(client(s.url).createVaultSetup({ returnUrl: "https://a/r", cancelUrl: "https://a/c", requestId: "x" }), /did not return an approval link/);
  } finally {
    await s.close();
  }
});

test("finishing a connection checks the approval first, then saves the account and returns its reference and email", async () => {
  const s = await stub(vaultRoute());
  try {
    assert.deepEqual(await client(s.url).completeVaultSetup({ setupTokenId: "ST1", requestId: "done-1" }), { vaultId: "PT1", payerEmail: "buyer@example.com" });
    const order = s.requests.filter((r) => r.url.startsWith("/v3/vault")).map((r) => `${r.method} ${r.url}`);
    assert.deepEqual(order, ["GET /v3/vault/setup-tokens/ST1", "POST /v3/vault/payment-tokens"]);
    const save = s.requests.find((r) => r.url === "/v3/vault/payment-tokens")!;
    assert.deepEqual(save.body, { payment_source: { token: { id: "ST1", type: "SETUP_TOKEN" } } });
    assert.equal(save.headers["paypal-request-id"], "done-1");
  } finally {
    await s.close();
  }
});

test("if PayPal does not give an email, the connection still works without one", async () => {
  const s = await stub(vaultRoute({ "POST /v3/vault/payment-tokens": () => ({ status: 200, json: { id: "PT2" } }) }));
  try {
    assert.deepEqual(await client(s.url).completeVaultSetup({ setupTokenId: "ST1", requestId: "x" }), { vaultId: "PT2", payerEmail: null });
  } finally {
    await s.close();
  }
});

test("a connection the person has not approved is refused and nothing is saved", async () => {
  const s = await stub(vaultRoute({ "GET /v3/vault/setup-tokens/ST1": () => ({ status: 200, json: { id: "ST1", status: "PAYER_ACTION_REQUIRED" } }) }));
  try {
    await assert.rejects(client(s.url).completeVaultSetup({ setupTokenId: "ST1", requestId: "x" }), /PAYER_ACTION_REQUIRED, not approved/);
    assert.ok(!s.requests.some((r) => r.url === "/v3/vault/payment-tokens"), "no account was saved");
  } finally {
    await s.close();
  }
});

test("forgetting a saved account uses DELETE, and a refusal from PayPal is an error that names the step", async () => {
  const s = await stub(vaultRoute());
  try {
    await client(s.url).deleteVault({ vaultId: "PT1" });
    assert.ok(s.requests.some((r) => r.method === "DELETE" && r.url === "/v3/vault/payment-tokens/PT1"));
    await assert.rejects(client(s.url).deleteVault({ vaultId: "missing/id" }), (err: unknown) => err instanceof PayPalError && err.step === "Forget the PayPal account");
  } finally {
    await s.close();
  }
});

// ---------- refunds and webhook checks ----------

test("a refund sends the amount, our case id and a repeat-safe request id, and reads PayPal's status", async () => {
  const stubbed = await stub((req) => {
    if (req.url === "/v1/oauth2/token") return { status: 200, json: { access_token: "tok", expires_in: 3600 } };
    if (req.url === "/v2/payments/captures/CAP%2F1/refund") return { status: 201, json: { id: "R1", status: "COMPLETED", custom_id: "case-1" } };
    if (req.url === "/v2/payments/captures/CAP2/refund") return { status: 201, json: { id: "R2", status: "PENDING" } };
    if (req.url === "/v2/payments/captures/CAP3/refund") return { status: 201, json: { id: "R3", status: "FAILED" } };
    if (req.url === "/v2/payments/captures/CAP4/refund") return { status: 201, json: { id: "R4" } };
    if (req.url === "/v2/payments/captures/CAP5/refund") return { status: 422, json: { name: "UNPROCESSABLE_ENTITY", message: "The refund amount must be less than or equal to the capture amount that has not yet been refunded.", details: [{ issue: "CAPTURE_FULLY_REFUNDED" }] }, headers: { "paypal-debug-id": "dbg" } };
    return { status: 404, json: { name: "NOT_FOUND", message: req.url } };
  });
  try {
    const client = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: stubbed.url });
    const done = await client.refund({ captureId: "CAP/1", amountCents: 605, requestId: "refund-case-1", note: "x".repeat(300), customId: "case-1" });
    assert.deepEqual(done, { refundId: "R1", status: "completed" });
    const sent = stubbed.requests.find((r) => r.url.includes("/refund"))!;
    assert.equal(sent.method, "POST");
    assert.equal(sent.headers["paypal-request-id"], "refund-case-1", "a repeat is recognised by PayPal");
    assert.deepEqual(sent.body.amount, { currency_code: "USD", value: "6.05" }, "always an explicit amount, never a default full refund");
    assert.equal(sent.body.custom_id, "case-1");
    assert.equal(sent.body.note_to_payer.length, 255, "cut to the length PayPal allows");
    assert.equal((await client.refund({ captureId: "CAP2", amountCents: 100, requestId: "r2", note: "n", customId: "c" })).status, "pending");
    assert.equal((await client.refund({ captureId: "CAP3", amountCents: 100, requestId: "r3", note: "n", customId: "c" })).status, "failed");
    assert.equal((await client.refund({ captureId: "CAP4", amountCents: 100, requestId: "r4", note: "n", customId: "c" })).status, "failed", "a status we do not recognise is not treated as success");
    await assert.rejects(client.refund({ captureId: "CAP5", amountCents: 100, requestId: "r5", note: "n", customId: "c" }), (e) => e instanceof PayPalError && e.step === "Refund the buyer" && e.status === 422 && e.issue === "CAPTURE_FULLY_REFUNDED" && e.debugId === "dbg");
    await assert.rejects(client.refund({ captureId: "CAP2", amountCents: 0, requestId: "r6", note: "n", customId: "c" }), /positive whole cents/);
  } finally {
    await stubbed.close();
  }
});

test("a webhook is checked by sending PayPal the event exactly as received, with the headers it came with", async () => {
  let verdict = "SUCCESS";
  const stubbed = await stub((req) => {
    if (req.url === "/v1/oauth2/token") return { status: 200, json: { access_token: "tok", expires_in: 3600 } };
    if (req.url === "/v1/notifications/verify-webhook-signature") return { status: 200, json: { verification_status: verdict } };
    return { status: 404, json: { name: "NOT_FOUND" } };
  });
  const headers = {
    "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert.pem", "paypal-transmission-id": "tid-1",
    "paypal-transmission-sig": "sig==", "paypal-transmission-time": "2026-11-11T10:00:00Z",
  };
  // Spacing, order and escapes in this body must reach PayPal untouched, or the signature will not match.
  const rawBody = '{ "id":"WH-1",  "event_type":"PAYMENT.CAPTURE.REFUNDED",\n  "resource":{"note":"caf\\u00e9 \\"quoted\\"", "amount": {"value":"5.00"}} }';
  try {
    const client = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: stubbed.url, webhookId: "WID-1" });
    assert.equal(await client.verifyWebhook({ headers, rawBody }), true);
    const sent = stubbed.requests.find((r) => r.url === "/v1/notifications/verify-webhook-signature")!;
    assert.equal(sent.headers.authorization, "Bearer tok");
    const text = JSON.stringify(sent.body);
    const { webhook_event: _event, ...rest } = sent.body;
    assert.deepEqual(rest, { auth_algo: "SHA256withRSA", cert_url: "https://api.paypal.com/cert.pem", transmission_id: "tid-1", transmission_sig: "sig==", transmission_time: "2026-11-11T10:00:00Z", webhook_id: "WID-1" });
    assert.deepEqual(sent.body.webhook_event, JSON.parse(rawBody));
    assert.ok(text.length > 0);
    // The request body on the wire contains the original text of the event, character for character.
    const wire = await new Promise<string>((resolve) => {
      const probe = http.createServer((rq, rs) => {
        let d = "";
        rq.on("data", (c) => (d += c));
        rq.on("end", () => {
          if (rq.url === "/v1/oauth2/token") { rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ access_token: "t", expires_in: 3600 })); return; }
          rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify({ verification_status: "SUCCESS" }));
          resolve(d);
        });
      });
      probe.listen(0, "127.0.0.1", async () => {
        const c2 = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: `http://127.0.0.1:${(probe.address() as AddressInfo).port}`, webhookId: "WID-1" });
        await c2.verifyWebhook({ headers, rawBody });
        probe.closeAllConnections();
        probe.close();
      });
    });
    assert.ok(wire.includes(`"webhook_event":${rawBody}`), "the event is placed in the request as received");

    verdict = "FAILURE";
    assert.equal(await client.verifyWebhook({ headers, rawBody }), false);
    verdict = "SOMETHING_NEW";
    assert.equal(await client.verifyWebhook({ headers, rawBody }), false, "anything but SUCCESS is a failure");
  } finally {
    await stubbed.close();
  }
});

test("a webhook is never believed without a webhook id, without every header, or when PayPal cannot be reached", async () => {
  const stubbed = await stub((req) => (req.url === "/v1/oauth2/token" ? { status: 200, json: { access_token: "tok", expires_in: 3600 } } : { status: 200, json: { verification_status: "SUCCESS" } }));
  const headers = {
    "paypal-auth-algo": "a", "paypal-cert-url": "https://x/c", "paypal-transmission-id": "t", "paypal-transmission-sig": "s", "paypal-transmission-time": "2026-11-11T10:00:00Z",
  };
  try {
    const noId = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: stubbed.url });
    assert.equal(await noId.verifyWebhook({ headers, rawBody: "{}" }), false, "no webhook id set up");
    const client = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: stubbed.url, webhookId: "W" });
    for (const missing of Object.keys(headers)) {
      const partial: Record<string, string> = { ...headers };
      delete partial[missing];
      assert.equal(await client.verifyWebhook({ headers: partial, rawBody: "{}" }), false, `without ${missing}`);
    }
    assert.equal(stubbed.requests.filter((r) => r.url.includes("verify")).length, 0, "nothing was asked of PayPal when a header was missing");
  } finally {
    await stubbed.close();
  }
  const down = createPayPalClient({ clientId: "id", clientSecret: "secret", baseUrl: "http://127.0.0.1:1", webhookId: "W", timeoutMs: 500 });
  assert.equal(await down.verifyWebhook({ headers, rawBody: "{}" }), false);
});
