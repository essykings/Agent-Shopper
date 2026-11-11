// A stand-in for PayPal, for tests. It records every call and can be told to fail.

import { PayPalError } from "./paypal-port.ts";
import type { AuthorizeInput, PayPalPort, PayoutInput, PayoutStatus, RefundInput, RefundStatus } from "./paypal-port.ts";

export class FakePayPal implements PayPalPort {
  calls: Array<{ method: string; args: unknown }> = [];
  failAuthorize: string | null = null;
  failCapture: string | null = null;
  failVoid: string | null = null;
  /** One outcome is used per payout call; when empty, payouts succeed. */
  payoutOutcomes: PayoutStatus[] = [];
  authorizeDelayMs = 0;
  failRefund: string | null = null;
  /** One outcome is used per refund call; when empty, refunds complete. */
  refundOutcomes: RefundStatus[] = [];
  /** A webhook counts as real only if it carries this value in its transmission signature header. */
  validSignature = "valid";
  failSetup: string | null = null;
  failComplete: string | null = null;
  failDelete: string | null = null;
  /** Saved accounts that were asked to be forgotten. */
  deleted: string[] = [];
  private vaults = 0;

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }

  async authorizeSaved(i: AuthorizeInput) {
    this.calls.push({ method: "authorizeSaved", args: i });
    if (this.authorizeDelayMs) await new Promise((r) => setTimeout(r, this.authorizeDelayMs));
    if (this.failAuthorize) throw new PayPalError("Hold the money", 422, this.failAuthorize, "BILLING_AGREEMENT_NOT_FOUND");
    return { orderId: `ORDER-${i.requestId}`, authorizationId: `AUTH-${i.requestId}` };
  }

  async createVaultSetup(i: { returnUrl: string; cancelUrl: string; requestId: string }) {
    this.calls.push({ method: "createVaultSetup", args: i });
    if (this.failSetup) throw new PayPalError("Start connecting PayPal", 400, this.failSetup);
    // A pretend consent page served by the app itself in mock mode.
    const origin = new URL(i.returnUrl).origin;
    return { setupTokenId: `SETUP-${i.requestId}`, approveUrl: `${origin}/mock-paypal/approve?ok=${encodeURIComponent(i.returnUrl)}&cancel=${encodeURIComponent(i.cancelUrl)}` };
  }

  async completeVaultSetup(i: { setupTokenId: string; requestId: string }) {
    this.calls.push({ method: "completeVaultSetup", args: i });
    if (this.failComplete) throw new PayPalError("Check the PayPal approval", 422, this.failComplete);
    return { vaultId: `MOCK-OWN-${++this.vaults}`, payerEmail: "buyer@mock.example" };
  }

  async deleteVault(i: { vaultId: string }) {
    this.calls.push({ method: "deleteVault", args: i });
    if (this.failDelete) throw new PayPalError("Forget the PayPal account", 500, this.failDelete);
    this.deleted.push(i.vaultId);
  }

  async capture(i: { authorizationId: string; requestId: string }) {
    this.calls.push({ method: "capture", args: i });
    if (this.failCapture) throw new PayPalError("Take the money", 422, this.failCapture);
    return { captureId: `CAP-${i.requestId}` };
  }

  async voidAuthorization(i: { authorizationId: string; requestId: string }) {
    this.calls.push({ method: "voidAuthorization", args: i });
    if (this.failVoid) throw new PayPalError("Release the hold", 500, this.failVoid);
  }

  async refund(i: RefundInput) {
    this.calls.push({ method: "refund", args: i });
    if (this.failRefund) throw new PayPalError("Refund the buyer", 422, this.failRefund, "CAPTURE_FULLY_REFUNDED");
    const status = this.refundOutcomes.shift() ?? "completed";
    return { refundId: `REFUND-${i.requestId}`, status };
  }

  async verifyWebhook(i: { headers: Record<string, string>; rawBody: string }) {
    this.calls.push({ method: "verifyWebhook", args: { headers: i.headers } });
    return i.headers["paypal-transmission-sig"] === this.validSignature;
  }

  async payout(i: PayoutInput) {
    this.calls.push({ method: "payout", args: i });
    const status = this.payoutOutcomes.shift() ?? "success";
    return { payoutBatchId: `BATCH-${i.batchId}`, status, detail: status === "failed" ? "test failure" : undefined };
  }
}
