// The entry points a public server must use. They admit the caller first (see limits.ts) and only then
// run the agent or the purchase, so the limits cannot be skipped by forgetting a check.
// The plain functions in buy.ts have no limits: they are for tests and for the owner's own scripts.

import { DEFAULT_MODEL } from "../agent/shopper.ts";
import type { ShopRef } from "../agent/shopper.ts";
import { costMicroUsd, worstCaseMicroUsd } from "../agent/pricing.ts";
import { approveAndBuy, proposeAndBuy } from "./buy.ts";
import type { BuyDeps, BuyResult } from "./buy.ts";
import type { Pool } from "./db.ts";
import type { PurchaseResult } from "./payments.ts";
import { admit, settle } from "./limits.ts";
import type { Limits } from "./limits.ts";

export interface GuardedDeps extends BuyDeps {
  limits: Limits;
}

/** Runs the agent for one request. Refuses with a LimitError when the caller is over a limit. */
export async function guardedProposeAndBuy(
  pool: Pool,
  deps: GuardedDeps,
  input: { userId: string; mandateId: string; shops: ShopRef[]; ip: string | null | undefined },
): Promise<BuyResult> {
  const model = deps.modelName ?? DEFAULT_MODEL;
  const admission = await admit(pool, deps.limits, {
    kind: "agent_run",
    ip: input.ip,
    userId: input.userId,
    reserveMicroUsd: worstCaseMicroUsd(model, deps.limits.runTokenCap),
  });
  let actual: number | null = null;
  try {
    const result = await proposeAndBuy(pool, { ...deps, modelName: model, maxTotalTokens: deps.limits.runTokenCap, deadlineMs: Math.round(deps.limits.runDeadlineSeconds * 1000) }, input);
    actual = costMicroUsd(model, result.run.usage);
    return result;
  } finally {
    // If the run crashed, the cost is unknown, so the worst-case reservation stays counted.
    await settle(pool, admission.id, actual);
  }
}

/** The owner approves a proposal. Counts as a purchase against the caller's limit. */
export async function guardedApproveAndBuy(
  pool: Pool,
  deps: GuardedDeps,
  input: { userId: string; mandateId: string; proposalId: string; approvedTotalCents: number; ip: string | null | undefined },
): Promise<PurchaseResult> {
  const admission = await admit(pool, deps.limits, { kind: "purchase", ip: input.ip, userId: input.userId, reserveMicroUsd: 0 });
  try {
    return await approveAndBuy(pool, deps, input);
  } finally {
    await settle(pool, admission.id, 0);
  }
}
