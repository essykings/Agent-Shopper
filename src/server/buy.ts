// The whole buying flow in one place:
//   request -> shopper agent proposes -> guard -> (owner approves if asked) -> payment service -> shop gets the order
//
// The agent never touches money. Whatever it proposes is checked by the guard when it is made, and
// the payment service checks again with a fresh price right before anything is charged.

import { dbGuardFacts } from "../agent/facts.ts";
import { parseProduct } from "../agent/pages.ts";
import type { PageFetcher } from "../agent/pages.ts";
import { runShopperAgent } from "../agent/shopper.ts";
import type { ShopRef, ShopperDeps, ShopperOutcome, ShopperRun, ModelPort } from "../agent/shopper.ts";
import { dbStore } from "../agent/store.ts";
import type { Emit, WorldEvent } from "../shared/events.ts";
import type { Claim, Proposal, SellerStatus } from "../shared/types.ts";
import { SHOPS } from "../shops/catalog.ts";
import { money } from "../shops/pages.ts";
import { notify } from "./notifications.ts";
import { receiveOrder } from "../shops/service.ts";
import type { Pool } from "./db.ts";
import { loadMandate, purchase } from "./payments.ts";
import type { PurchaseDeps, PurchaseResult } from "./payments.ts";
import type { PayPalPort } from "./paypal-port.ts";

export interface BuyDeps {
  paypal: PayPalPort;
  model: ModelPort;
  fetchPage: PageFetcher;
  modelName?: string;
  effort?: ShopperDeps["effort"];
  maxSteps?: number;
  /** Stops the agent once one run has used this many tokens. */
  maxTotalTokens?: number;
  /** Most milliseconds one shopper run may take. */
  deadlineMs?: number;
  /** Different searches the shopper must try before it may say it cannot find the item (default 3). */
  minSearches?: number;
  /** Live steps for the Playground and the Town square. */
  onEvent?: Emit;
  now?: () => Date;
}

export type BuyResult =
  /** The agent finished without a proposal: it gave up, was refused, or ran out of steps. */
  | { stage: "agent"; outcome: Exclude<ShopperOutcome, { status: "proposed" } | { status: "shortlist" }>; run: ShopperRun }
  /** A gift request: ideas for the owner to choose from. Nothing is charged. */
  | { stage: "shortlist"; picks: Array<{ proposalId: string; totalCents: number }>; summary: string; run: ShopperRun }
  /** There is a proposal, but the owner has to approve it before anything is charged. */
  | { stage: "owner"; proposalId: string; totalCents: number; run: ShopperRun }
  /** The proposal went to the payment service. */
  | { stage: "purchase"; proposalId: string; result: PurchaseResult; run: ShopperRun };

/** Every shop the app knows is allowed, and any other address is unknown and refused. The shop's score is what judges a shop. */
export function sellerStatusOf(shopId: string): SellerStatus {
  return SHOPS.some((s) => s.id === shopId) ? "allowed" : "unknown";
}

interface StoredProposal {
  proposal: Proposal;
  /** The product page the agent read, used to read the price again. */
  url: string;
}

async function loadProposal(pool: Pool, userId: string, mandateId: string, proposalId: string): Promise<StoredProposal> {
  const res = await pool.query(
    `select p.id, p.shop_id, p.item_key, p.category, p.total_cents, to_char(p.delivery_by, 'YYYY-MM-DD') as delivery_by,
            p.claims, p.seller_score, s.text, s.url
     from proposals p
     join snapshots s on s.id = p.snapshot_id
     join mandates m on m.id = p.mandate_id
     where p.id = $1 and p.mandate_id = $2 and m.user_id = $3`,
    [proposalId, mandateId, userId],
  );
  const r = res.rows[0];
  if (!r) throw new Error("Proposal not found.");
  return {
    url: r.url,
    proposal: {
      id: r.id,
      sellerId: r.shop_id,
      itemKey: r.item_key,
      category: r.category,
      totalCents: r.total_cents,
      deliveryBy: r.delivery_by,
      claims: r.claims as Claim[],
      snapshotText: r.text,
      sellerScore: r.seller_score,
    },
  };
}

function purchaseDeps(pool: Pool, deps: BuyDeps, url: string): PurchaseDeps {
  const now = (): Date => (deps.now ?? (() => new Date()))();
  return {
    paypal: deps.paypal,
    fetchCurrentTotalCents: async () => {
      try {
        return parseProduct(await deps.fetchPage(url))?.totalCents ?? null;
      } catch {
        return null;
      }
    },
    getSellerStatus: async (_userId, shopId) => sellerStatusOf(shopId),
    // The shop learns about the paid order, so it can ship (or misbehave, in the demo).
    afterCapture: async (info) => {
      // Tell the owner what was bought. A problem telling them must never stop the shop learning about the order.
      try {
        const shop = SHOPS.find((s) => s.id === info.shopId);
        const itemName = shop?.products.find((p) => p.key === info.itemKey)?.name ?? "your item";
        await notify(pool, { userId: info.userId, kind: "bought", text: `Bought ${itemName} for ${money(info.totalCents)} from ${shop?.name ?? "the shop"}.`, href: "#/orders", key: `order:${info.orderId}:bought` });
      } catch {
        // Not important enough to stop anything.
      }
      await receiveOrder(pool, { orderId: info.orderId, shopId: info.shopId, itemKey: info.itemKey, now: now() });
    },
    ...(deps.now ? { now: deps.now } : {}),
  };
}

/** Sends a saved proposal to the payment service. The guard runs again inside, with a fresh price. */
export async function buyProposal(
  pool: Pool,
  deps: BuyDeps,
  input: { userId: string; mandateId: string; proposalId: string; approval?: { proposalId: string; approvedTotalCents: number } },
): Promise<PurchaseResult> {
  const { proposal, url } = await loadProposal(pool, input.userId, input.mandateId, input.proposalId);
  note(deps, { type: "pay", step: "start", shopId: proposal.sellerId, totalCents: proposal.totalCents });
  const result = await purchase(pool, purchaseDeps(pool, deps, url), {
    userId: input.userId,
    mandateId: input.mandateId,
    proposal,
    ...(input.approval ? { approval: input.approval } : {}),
  });
  const charged = result.status === "paid_out" || result.status === "payout_pending" || result.status === "payout_failed";
  note(deps, { type: "pay", step: charged ? "done" : "failed", shopId: proposal.sellerId, totalCents: proposal.totalCents });
  return result;
}

/**
 * The owner approves a proposal they were shown. They approve the amount they saw, nothing more:
 * if the price has gone up since, the payment service stops and nothing is charged.
 */
export async function approveAndBuy(
  pool: Pool,
  deps: BuyDeps,
  input: { userId: string; mandateId: string; proposalId: string; approvedTotalCents: number },
): Promise<PurchaseResult> {
  return buyProposal(pool, deps, {
    userId: input.userId,
    mandateId: input.mandateId,
    proposalId: input.proposalId,
    approval: { proposalId: input.proposalId, approvedTotalCents: input.approvedTotalCents },
  });
}

/** Tells the live screens something happened. A failing listener never changes the purchase. */
function note(deps: Pick<BuyDeps, "onEvent">, e: WorldEvent): void {
  try {
    deps.onEvent?.(e);
  } catch {
    // Optional.
  }
}

/** Runs the agent for one request and, if the guard allows its proposal, buys it. */
export async function proposeAndBuy(
  pool: Pool,
  deps: BuyDeps,
  input: { userId: string; mandateId: string; shops: ShopRef[] },
): Promise<BuyResult> {
  const { mandate } = await loadMandate(pool, input.userId, input.mandateId);
  const run = await runShopperAgent(
    {
      model: deps.model,
      fetchPage: deps.fetchPage,
      store: dbStore(pool),
      getGuardFacts: dbGuardFacts(pool, {
        userId: input.userId,
        mandateId: input.mandateId,
        getSellerStatus: async (shopId) => sellerStatusOf(shopId),
        ...(deps.now ? { now: deps.now } : {}),
      }),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.modelName ? { modelName: deps.modelName } : {}),
      ...(deps.effort ? { effort: deps.effort } : {}),
      ...(deps.maxSteps ? { maxSteps: deps.maxSteps } : {}),
      ...(deps.maxTotalTokens ? { maxTotalTokens: deps.maxTotalTokens } : {}),
      ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}),
      ...(deps.minSearches !== undefined ? { minSearches: deps.minSearches } : {}),
      ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    },
    { mandate, shops: input.shops },
  );

  if (run.outcome.status === "shortlist") {
    note(deps, { type: "end", result: "asked" });
    return { stage: "shortlist", picks: run.outcome.picks.map((p) => ({ proposalId: p.proposal.id, totalCents: p.proposal.totalCents })), summary: run.outcome.summary, run };
  }
  if (run.outcome.status !== "proposed") {
    note(deps, { type: "end", result: run.outcome.status === "gave_up" ? "nothing" : "stopped" });
    return { stage: "agent", outcome: run.outcome, run };
  }
  const { proposal, guard } = run.outcome;
  if (guard.decision === "ask") {
    note(deps, { type: "end", result: "asked" });
    return { stage: "owner", proposalId: proposal.id, totalCents: proposal.totalCents, run };
  }

  const result = await buyProposal(pool, deps, { userId: input.userId, mandateId: input.mandateId, proposalId: proposal.id });
  note(deps, { type: "end", result: result.status === "paid_out" || result.status === "payout_pending" || result.status === "payout_failed" ? "bought" : "stopped" });
  return { stage: "purchase", proposalId: proposal.id, result, run };
}
