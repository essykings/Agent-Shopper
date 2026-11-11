// The only way the app talks to PayPal. The real client and the test fake both fit this shape.

export interface AuthorizeInput {
  /** The buyer's saved PayPal. */
  vaultId: string;
  amountCents: number;
  /** PayPal keeps this for a few hours and ignores a repeat, so a retry never charges twice. */
  requestId: string;
  description: string;
  /** Our order id, echoed back on PayPal's events so a payment can always be traced to an order. */
  customId: string;
}

export interface PayoutInput {
  receiverEmail: string;
  amountCents: number;
  /** Must be unique per attempt. */
  batchId: string;
  note: string;
}

export type PayoutStatus = "success" | "pending" | "failed";

export interface RefundInput {
  /** The captured payment to refund (part of). */
  captureId: string;
  amountCents: number;
  /** A repeat with the same id never refunds twice. */
  requestId: string;
  /** Shown to the buyer by PayPal. */
  note: string;
  /** Our case id, echoed back by PayPal so a refund can always be traced to its case. */
  customId: string;
}

export type RefundStatus = "completed" | "pending" | "failed";

export interface PayPalPort {
  /** Puts the money on hold on the buyer's saved PayPal. Nothing is taken yet. */
  authorizeSaved(input: AuthorizeInput): Promise<{ orderId: string; authorizationId: string }>;
  /** Takes the money held by authorizeSaved. */
  capture(input: { authorizationId: string; requestId: string }): Promise<{ captureId: string }>;
  /** Releases a hold without taking anything. */
  voidAuthorization(input: { authorizationId: string; requestId: string }): Promise<void>;
  /** Starts connecting a person's own PayPal account. They approve on PayPal's page, then come back to returnUrl. */
  createVaultSetup(input: { returnUrl: string; cancelUrl: string; requestId: string }): Promise<{ setupTokenId: string; approveUrl: string }>;
  /** Finishes the connection after they approved. Returns the reference used to charge their account later. */
  completeVaultSetup(input: { setupTokenId: string; requestId: string }): Promise<{ vaultId: string; payerEmail: string | null }>;
  /** Asks PayPal to forget a saved account. */
  deleteVault(input: { vaultId: string }): Promise<void>;
  /** Pays a shop's PayPal account from the app's account. */
  payout(input: PayoutInput): Promise<{ payoutBatchId: string; status: PayoutStatus; detail?: string }>;
  /** Gives some or all of a captured payment back to the buyer. */
  refund(input: RefundInput): Promise<{ refundId: string; status: RefundStatus }>;
  /**
   * Asks PayPal whether a webhook really came from PayPal. The raw body must be exactly as received.
   * False when it fails, when it cannot be checked, or when no webhook is set up.
   */
  verifyWebhook(input: { headers: Record<string, string>; rawBody: string }): Promise<boolean>;
}

export class PayPalError extends Error {
  step: string;
  status: number;
  issue: string | null;
  debugId: string | null;
  constructor(step: string, status: number, message: string, issue: string | null = null, debugId: string | null = null) {
    super(`${step} failed: ${message}`);
    this.name = "PayPalError";
    this.step = step;
    this.status = status;
    this.issue = issue;
    this.debugId = debugId;
  }
}
