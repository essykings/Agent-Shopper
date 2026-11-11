// How the agent reads shop websites. Everything the agent is told about a page is worked out
// here, in plain code, so the numbers on a proposal never depend on what the model says.

import { pageText } from "../shops/pages.ts";

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  /** Visible and hidden text, as a plain scraper would read it. */
  text: string;
  title: string;
}

export type PageFetcher = (url: string) => Promise<FetchedPage>;

export class PageFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageFetchError";
  }
}

export interface FetcherOptions {
  /** Hosts with port, for example northgear.localhost:4101. Anything else is refused. */
  allowedHosts: string[];
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const decode = (s: string): string =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export interface PageLink {
  text: string;
  url: string;
}

const MAX_PRODUCT_LINKS = 30;
const MAX_OTHER_LINKS = 14;

/**
 * The links on a page, as a browser would show them: what each says and where it goes. A person
 * clicks a product's name to open it, but an agent reading only the text cannot, so it is handed the
 * addresses. Only links to the same shop count, product links first. The shop wrote the link text, so
 * like the rest of the page it is untrusted; the page reader refuses any other site anyway.
 */
export function extractLinks(page: FetchedPage): PageLink[] {
  const base = new URL(page.url);
  const products: PageLink[] = [];
  const others: PageLink[] = [];
  const seen = new Set<string>();
  for (const m of page.html.matchAll(/<a\s[^>]*?href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    let target: URL;
    try {
      target = new URL(decode(m[2]!), base);
    } catch {
      continue;
    }
    if (target.host !== base.host || (target.protocol !== "http:" && target.protocol !== "https:")) continue;
    target.hash = "";
    const url = target.toString();
    const text = decode(m[3]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!text || seen.has(url) || url === page.url) continue;
    seen.add(url);
    (target.pathname.startsWith("/products/") ? products : others).push({ text, url });
  }
  // Paging links matter most after the products, so they go before the long row of department links.
  const paging = (l: PageLink): number => (/\b(next|previous) page\b/i.test(l.text) ? 0 : 1);
  const rest = [...others].sort((a, b) => paging(a) - paging(b));
  return [...products.slice(0, MAX_PRODUCT_LINKS), ...rest.slice(0, MAX_OTHER_LINKS)];
}

/** A page reader that can only open the listed shops, never follows redirects, and gives up after a timeout. */
export function createPageFetcher(opts: FetcherOptions): PageFetcher {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const doFetch = opts.fetchImpl ?? fetch;
  return async (raw: string): Promise<FetchedPage> => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new PageFetchError("That is not a valid web address.");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new PageFetchError("Only web pages can be opened.");
    if (!opts.allowedHosts.includes(u.host)) throw new PageFetchError(`${u.host} is not one of the shops you can browse.`);
    let res: Response;
    try {
      res = await doFetch(u.toString(), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/html" } });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new PageFetchError(timedOut ? `Opening the page took longer than ${timeoutMs / 1000} seconds.` : `Could not open the page: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status >= 300 && res.status < 400) throw new PageFetchError("That page redirects somewhere else, so it was not opened.");
    const html = await res.text();
    if (html.length > maxBytes) throw new PageFetchError("That page is too large to read.");
    const title = decode(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "");
    return { url: u.toString(), status: res.status, html, text: pageText(html), title };
  };
}

// ---------- product pages ----------

export interface ParsedProduct {
  itemKey: string;
  name: string;
  condition: string | null;
  category: string | null;
  totalCents: number | null;
  /** ISO date, for example 2026-11-18. */
  deliveryBy: string | null;
}

const toCents = (dollars: string, cents: string): number => Number(dollars.replace(/,/g, "")) * 100 + Number(cents);

/** Reads dates like "18 Nov 2026". British English writes September as "Sept", so that is accepted too. */
function isoFromShortDate(s: string): string | null {
  const t = Date.parse(`${s.replace(/\bSept\b/, "Sep")} UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Returns null when the page is not a product page. */
export function parseProduct(page: FetchedPage): ParsedProduct | null {
  const key = /\/products\/([^/?#]+)/.exec(new URL(page.url).pathname)?.[1];
  const total = /Total:\s*\$([\d,]+)\.(\d{2})/.exec(page.text);
  if (!key || !total) return null;
  const arrives = /Arrives (\d{1,2} [A-Za-z]{3,4} \d{4})\./.exec(page.text);
  return {
    itemKey: key,
    name: page.title.split(" | ")[0]!.trim(),
    condition: /Condition:\s*(.+?)\s+\$\d/.exec(page.text)?.[1] ?? null,
    category: /Category:\s*([^.]+)\./.exec(page.text)?.[1]?.trim() ?? null,
    totalCents: toCents(total[1]!, total[2]!),
    deliveryBy: arrives ? isoFromShortDate(arrives[1]!) : null,
  };
}

// ---------- about pages ----------

export interface ParsedAbout {
  /** ISO date the shop's website was registered. */
  registered: string | null;
  reviewCount: number;
  average: number | null;
  returnPolicy: string | null;
  /** ISO dates of each review. */
  reviewDates: string[];
  reviewTexts: string[];
}

export function parseAbout(page: FetchedPage): ParsedAbout {
  const reg = /Registered (\d{1,2} [A-Za-z]{3,4} \d{4})/.exec(page.text);
  const counts = /(\d+) reviews, average ([\d.]+) out of 5/.exec(page.text);
  const reviewDates: string[] = [];
  const reviewTexts: string[] = [];
  for (const m of page.html.matchAll(/<small>(\d{1,2} [A-Za-z]{3,4} \d{4}) · [^<]*<\/small>([^<]*)<\/span><\/li>/g)) {
    const d = isoFromShortDate(m[1]!);
    if (d) reviewDates.push(d);
    reviewTexts.push(decode(m[2]!).trim());
  }
  return {
    registered: reg ? isoFromShortDate(reg[1]!) : null,
    reviewCount: counts ? Number(counts[1]) : 0,
    average: counts ? Number(counts[2]) : null,
    returnPolicy: /Returns\s+(.+?)\s+(?:Price protection|Reviews)\s/.exec(page.text)?.[1] ?? null,
    reviewDates,
    reviewTexts,
  };
}

// ---------- text aimed at AI readers ----------

const INJECTION_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\bAI (assistant|agent|model|shopper)s?\b/i, what: "addresses an AI assistant" },
  { re: /\bignore (all |any |your |the )?(previous |prior |spending )?(instructions|limits|rules|budget)/i, what: "tells the reader to ignore its limits" },
  { re: /\bpre-?approved\b/i, what: "claims the order is pre-approved" },
  { re: /\b(system prompt|developer message)\b/i, what: "mentions a system prompt" },
];

/** Phrases a normal shop page has no reason to contain. Each match is a reason to distrust the shop. */
export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.what);
}
