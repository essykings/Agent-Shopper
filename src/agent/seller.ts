// The first seller check, in plain code. It reads the facts a shop publishes about itself and
// scores them. These are heuristics for a sandbox demo, not a real fraud model, and the numbers
// are chosen for the demo shops: say so when presenting them.

import type { ParsedAbout } from "./pages.ts";

export interface Finding {
  text: string;
  /** Points taken off 100. */
  points: number;
}

export interface SellerReport {
  /** 0 to 100. Higher is safer. */
  score: number;
  findings: Finding[];
}

const DAY_MS = 86_400_000;

export function scoreSeller(about: ParsedAbout, ctx: { now: Date; injectionSeen: boolean }): SellerReport {
  const findings: Finding[] = [];
  const take = (text: string, points: number): void => {
    findings.push({ text, points });
  };

  if (about.registered === null) {
    take("The shop does not say when its website was registered.", 20);
  } else {
    const days = Math.floor((ctx.now.getTime() - new Date(`${about.registered}T00:00:00Z`).getTime()) / DAY_MS);
    if (days < 30) take(`The website is only ${days} days old.`, 45);
    else if (days < 180) take(`The website is only ${days} days old.`, 25);
    else if (days < 365) take(`The website is less than a year old (${days} days).`, 10);
  }

  const n = about.reviewCount;
  if (n < 5) {
    take(`Only ${n} reviews.`, 15);
  } else if (n < 20) {
    take(`A short review history (${n} reviews).`, 8);
  }

  if (n >= 30 && about.reviewDates.length >= 30) {
    const perDay = new Map<string, number>();
    for (const d of about.reviewDates) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    const busiest = Math.max(...perDay.values());
    if (busiest / about.reviewDates.length >= 0.5) {
      take(`${busiest} of ${about.reviewDates.length} reviews were posted on a single day.`, 30);
    }
  }
  if (n >= 20 && about.reviewTexts.length >= 20) {
    const distinct = new Set(about.reviewTexts).size;
    if (distinct / about.reviewTexts.length < 0.1) {
      take(`The reviews repeat the same ${distinct} sentences.`, 20);
    }
  }
  if (n > 50 && about.average !== null && about.average >= 4.95) {
    take("Every review is five stars, which real shops almost never get.", 5);
  }

  if (!about.returnPolicy || /all sales (are )?final|no returns/i.test(about.returnPolicy)) {
    take("The shop does not accept returns.", 10);
  }

  if (ctx.injectionSeen) {
    take("The shop's pages contain hidden text written to manipulate an AI assistant.", 40);
  }

  const score = Math.max(0, Math.min(100, 100 - findings.reduce((s, f) => s + f.points, 0)));
  return { score, findings };
}
