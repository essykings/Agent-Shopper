// Words that must read the same wherever the app says them: on the request, in the message at the top, in notifications.
// One place builds them, so a change here changes all of them.

import { shopName } from "./world.ts";

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface GiveUp {
  /** The shopper's own short summary of why nothing was bought. */
  reason?: string | undefined;
  /** The cheapest real match from a trusted shop that was over the limit, found and checked by code. */
  closest?: { itemName: string; shopId: string; totalCents: number } | null | undefined;
  /** The most the owner would pay, to say how far over the closest option is. */
  limitCents?: number | null | undefined;
}

/** The first sentence of the shopper's reason, without any tool markup that slipped into it. "$621.00" is not a sentence end. */
function firstSentence(s: string): string {
  const clean = (s.split(/<\/?[a-z_]+[^>]*>/i)[0] ?? "").trim();
  return (clean.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? clean).trim();
}

/**
 * Why nothing was bought. When code found the item over the limit, one line built from checked numbers, and nothing the
 * shopper wrote. Otherwise the first sentence of the shopper's own reason. Whoever shows this puts its own opening in front
 * ("Nothing was bought." or "Nothing was bought for ...").
 */
export function giveUpBody(o: GiveUp): string {
  if (o.closest) {
    const c = o.closest;
    const over = typeof o.limitCents === "number" && c.totalCents > o.limitCents ? `, ${dollars(c.totalCents - o.limitCents)} over your ${dollars(o.limitCents)} limit` : "";
    return `The closest is ${c.itemName} at ${shopName(c.shopId)} for ${dollars(c.totalCents)}${over}.`;
  }
  return firstSentence(o.reason ?? "");
}
