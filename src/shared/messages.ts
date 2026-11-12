// Words that must read the same wherever the app says them: on the request, in the message at the top, in notifications.
// One place builds them, so a change here changes all of them.

import { shopName } from "./world.ts";

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export interface GiveUp {
  /** The shopper's own short summary of why nothing was bought. */
  reason?: string | undefined;
  /** The cheapest real match from a trusted shop that was over the limit, found and checked by code. */
  closest?: { itemName: string; shopId: string; totalCents: number } | null | undefined;
}

/**
 * Why nothing was bought: the shopper's own reason, and the cheapest option it could not afford if its reason did not
 * already say so. Whoever shows this puts its own opening in front ("Nothing was bought." or "Nothing was bought for ...").
 */
export function giveUpBody(o: GiveUp): string {
  const over = o.closest ? ` The cheapest option from a shop you can trust is ${o.closest.itemName} at ${shopName(o.closest.shopId)} for ${dollars(o.closest.totalCents)}.` : "";
  return `${o.reason ?? ""}${o.reason && o.closest && !o.reason.includes(dollars(o.closest.totalCents)) ? over : o.reason ? "" : over}`.trim();
}
