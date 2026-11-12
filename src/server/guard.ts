// The policy guard. Plain code, not an AI. It is the only thing that can say yes to money.
//
// Rules of the house:
//  - The model proposes. This function decides.
//  - Only the mandate and the facts in GuardContext decide the outcome. Text from a shop page
//    is evidence to check, never an instruction.
//  - Any deny wins over any ask, and any ask wins over allow.
//  - When something is unknown, the answer is "ask", never "allow".

import type { Check, CheckLevel, Decision, GuardContext, GuardResult, Mandate, Proposal } from "../shared/types.ts";

const MIN_QUOTE_LENGTH = 8;
const NEW_WORDS = /\b(new|sealed|unopened)\b/;
const NOT_NEW_WORDS = /\b(used|refurbished|renewed|pre-owned|open[- ]box)\b/;

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function endOfDay(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T23:59:59Z` : iso);
}

export function evaluate(mandate: Mandate, proposal: Proposal, ctx: GuardContext): GuardResult {
  const checks: Check[] = [];
  const add = (id: string, label: string, level: CheckLevel, detail: string): void => {
    checks.push({ id, label, level, detail });
  };
  const total = proposal.totalCents;

  // 1. The price is a real amount.
  if (!Number.isInteger(total) || total <= 0) {
    add("price-valid", "The price is a real amount", "deny", "The price could not be read as a valid amount.");
  } else {
    add("price-valid", "The price is a real amount", "pass", `Total ${dollars(total)}.`);
  }

  // 2. The shop is one the app knows. (The shop's score, checked next, is what judges a shop.)
  if (ctx.sellerStatus === "allowed") {
    add("shop-allowed", "The shop is one we know", "pass", "It is one of the shops this app can buy from.");
  } else if (ctx.sellerStatus === "ask_every_time") {
    add("shop-allowed", "The shop is one we know", "ask", "This shop needs your OK every time.");
  } else {
    add("shop-allowed", "The shop is one we know", "deny", "This is not one of the shops this app can buy from.");
  }

  // 3. The shop's score.
  if (proposal.sellerScore === null) {
    add("shop-score", "The shop's score is high enough", "ask", "The shop could not be scored, so your OK is needed.");
  } else if (proposal.sellerScore < mandate.sellerMinScore) {
    add("shop-score", "The shop's score is high enough", "deny", `Score ${proposal.sellerScore} is below your minimum of ${mandate.sellerMinScore}.`);
  } else {
    add("shop-score", "The shop's score is high enough", "pass", `Score ${proposal.sellerScore} of 100.`);
  }

  // 4. The price is within this request's limit.
  if (total > mandate.maxPriceCents) {
    add("within-limit", "Within your price limit", "deny", `${dollars(total)} is above your ${dollars(mandate.maxPriceCents)} limit.`);
  } else {
    add("within-limit", "Within your price limit", "pass", `${dollars(total)} is within ${dollars(mandate.maxPriceCents)}.`);
  }

  // 5. Enough set aside for this request, and within the monthly allowance.
  if (total > ctx.requestRemainingCents) {
    add("set-aside", "Enough set aside for this request", "deny", `Only ${dollars(ctx.requestRemainingCents)} is set aside for this request.`);
  } else {
    add("set-aside", "Enough set aside for this request", "pass", `${dollars(ctx.requestRemainingCents)} is set aside.`);
  }
  if (ctx.monthSpentCents + total > ctx.monthlyAllowanceCents) {
    add("allowance", "Within your monthly allowance", "deny", `This would take your month to ${dollars(ctx.monthSpentCents + total)} of ${dollars(ctx.monthlyAllowanceCents)}.`);
  } else {
    add("allowance", "Within your monthly allowance", "pass", `Month would be ${dollars(ctx.monthSpentCents + total)} of ${dollars(ctx.monthlyAllowanceCents)}.`);
  }

  // 6. The deadline.
  const deadline = endOfDay(mandate.deadline);
  if (Number.isNaN(deadline.getTime())) {
    add("deadline", "Arrives before your deadline", "deny", "The deadline could not be read.");
  } else if (ctx.now > deadline) {
    add("deadline", "Arrives before your deadline", "deny", `Your deadline of ${mandate.deadline} has passed.`);
  } else if (proposal.deliveryBy === null) {
    add("deadline", "Arrives before your deadline", "ask", "The shop does not say when it will arrive.");
  } else if (endOfDay(proposal.deliveryBy) > deadline) {
    add("deadline", "Arrives before your deadline", "deny", `Arrives ${proposal.deliveryBy}, after your deadline of ${mandate.deadline}.`);
  } else {
    add("deadline", "Arrives before your deadline", "pass", `Arrives ${proposal.deliveryBy}.`);
  }

  // 7. Not something you never buy. Only shown when a request carries a ban list; with no list there is nothing to check or to show.
  if (mandate.neverBuyCategories.length > 0) {
    const blockedCategory = mandate.neverBuyCategories.find((c) => normalize(c) === normalize(proposal.category));
    if (blockedCategory) {
      add("category", "Not on your never-buy list", "deny", `${proposal.category} is on your never-buy list.`);
    } else {
      add("category", "Not on your never-buy list", "pass", `${proposal.category} is fine.`);
    }
  }

  // 8. Every claim is backed by words really on the saved page.
  const snapshot = normalize(proposal.snapshotText);
  const needed: Array<"item" | "condition"> = mandate.condition === "new" ? ["item", "condition"] : ["item"];
  for (const rule of needed) {
    const label = rule === "item" ? (mandate.kind === "gift" ? "The page shows what the gift is" : "The page shows it is the right item") : "The page shows it is new and sealed";
    const claims = proposal.claims.filter((c) => c.rule === rule);
    if (claims.length === 0) {
      add(`proof-${rule}`, label, "deny", "Your shopper gave no proof from the page.");
      continue;
    }
    const proven = claims.some((c) => {
      const quote = normalize(c.quote);
      if (quote.length < MIN_QUOTE_LENGTH || !snapshot.includes(quote)) return false;
      if (rule === "condition") return NEW_WORDS.test(quote) && !NOT_NEW_WORDS.test(quote);
      return true;
    });
    if (proven) {
      add(`proof-${rule}`, label, "pass", `Found on the saved page: "${claims[0]!.quote}".`);
    } else {
      add(`proof-${rule}`, label, "deny", "The quoted words are not on the saved page, or do not say what is claimed.");
    }
  }

  // 9. Not already bought.
  if (ctx.alreadyOrdered) {
    add("duplicate", "Not bought already", "deny", "This request already has an order.");
  } else {
    add("duplicate", "Not bought already", "pass", "No order yet for this request.");
  }

  // 10. The price has not gone up since the shopper saved the page.
  if (ctx.currentTotalCents === null) {
    add("price-same", "The price has not gone up", "ask", "The shop's price could not be checked again.");
  } else if (ctx.currentTotalCents > total) {
    add("price-same", "The price has not gone up", "deny", `The price rose from ${dollars(total)} to ${dollars(ctx.currentTotalCents)}.`);
  } else {
    add("price-same", "The price has not gone up", "pass", `Still ${dollars(ctx.currentTotalCents)} or less.`);
  }

  // 11. Above your ask-me limit. A gift is a matter of taste, so a gift pick always needs the owner's choice.
  if (mandate.kind === "gift") {
    add("gift-choice", "You choose the gift", "ask", "Gifts are a matter of taste, so nothing is bought until you pick one.");
  } else if (total > mandate.askAboveCents) {
    add("ask-limit", "Under your ask-me limit", "ask", `${dollars(total)} is above your ${dollars(mandate.askAboveCents)} ask-me limit.`);
  } else {
    add("ask-limit", "Under your ask-me limit", "pass", `${dollars(total)} is under ${dollars(mandate.askAboveCents)}.`);
  }

  const decision: Decision = checks.some((c) => c.level === "deny")
    ? "deny"
    : checks.some((c) => c.level === "ask")
      ? "ask"
      : "allow";
  return { decision, checks };
}
