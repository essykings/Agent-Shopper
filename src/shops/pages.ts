// Plain HTML for the demo shops and the control panel. No framework: strings in, strings out.
// The visible design can change freely. The sentences an agent reads (conditions, totals, arrival
// dates, registration date, review counts) are covered by tests and must keep their wording.

import { categoriesOf } from "./catalog.ts";
import type { Product, Review, ShopDef } from "./catalog.ts";

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** The listed price after the control panel's percent change. */
export const priceNow = (p: Product, adjustPct: number): number => Math.round((p.priceCents * (100 + adjustPct)) / 100);

export const formatDate = (d: Date | string): string => {
  const date = typeof d === "string" ? new Date(d.length === 10 ? `${d}T00:00:00Z` : d) : d;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

export const arrivesOn = (now: Date, days: number): string => {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + days);
  return formatDate(d);
};

/** What a plain text scraper sees: tags removed, hidden elements included. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- shop look ----------

const avg = (reviews: Review[]): number => (reviews.length ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length : 0);
const stars = (rating: number): string => "★".repeat(Math.round(rating)) + "☆".repeat(5 - Math.round(rating));
const isScam = (shop: ShopDef): boolean => shop.behavior === "scam";
/** Deal-Zone shows a made-up "was" price. Its total is still the real price on the page. */
const fakeWasCents = (price: number): number => Math.round((price * 2.6) / 100) * 100;

const PRODUCT_ART: Record<string, string> = {
  "ps5-disc": `<rect class="w" x="72" y="14" width="56" height="112" rx="26"/><rect class="k" x="94" y="24" width="12" height="92" rx="6"/><circle class="a" cx="100" cy="118" r="4"/>`,
  "ps5-digital-used": `<rect class="w" x="72" y="14" width="56" height="112" rx="26" style="stroke-dasharray:6 5"/><rect class="k" x="94" y="24" width="12" height="92" rx="6"/><path d="M80 40l14 6M118 90l-12 8" style="stroke:var(--ink);stroke-width:2"/>`,
  earbuds: `<rect class="w" x="60" y="56" width="80" height="58" rx="24"/><circle class="a" cx="86" cy="46" r="15"/><circle class="a" cx="114" cy="46" r="15"/><rect class="k" x="84" y="58" width="4" height="14" rx="2"/><rect class="k" x="112" y="58" width="4" height="14" rx="2"/>`,
  "usb-hub": `<path d="M30 78H8" style="stroke:var(--ink);stroke-width:6;stroke-linecap:round"/><rect class="w" x="30" y="58" width="140" height="40" rx="12"/><rect class="k" x="48" y="72" width="20" height="12" rx="3"/><rect class="k" x="76" y="72" width="20" height="12" rx="3"/><rect class="k" x="104" y="72" width="20" height="12" rx="3"/><rect class="a" x="132" y="72" width="22" height="12" rx="3"/>`,
  "gift-card-50": `<rect class="a" x="35" y="30" width="130" height="80" rx="12"/><rect x="95" y="30" width="10" height="80" style="fill:#fff;opacity:.85"/><circle class="w" cx="100" cy="30" r="9"/>`,
  "trail-socks": `<path class="a" d="M52 18h30v46l26 20a14 14 0 0 1-8 26l-42-14a14 14 0 0 1-6-12z"/><path class="k" d="M52 30h30M52 40h30" style="stroke:#fff;stroke-width:4"/><path class="w" d="M112 22h30v46l26 20a14 14 0 0 1-8 26l-42-14a14 14 0 0 1-6-12z"/>`,
  "hiking-pole": `<line x1="150" y1="14" x2="62" y2="126" style="stroke:var(--ink);stroke-width:7;stroke-linecap:round"/><line x1="150" y1="14" x2="136" y2="34" style="stroke:var(--accent);stroke-width:15;stroke-linecap:round"/>`,
  "glass-kettle": `<path class="w" d="M62 50h66l8 60a8 8 0 0 1-8 9H62a8 8 0 0 1-8-9z"/><path class="w" d="M62 64l-22-14 4-8 26 14z"/><path d="M136 62q30 8 0 40" style="fill:none;stroke:var(--ink);stroke-width:6;stroke-linecap:round"/><rect class="a" x="70" y="40" width="50" height="10" rx="5"/>`,
};

/** Products without their own drawing get a simple one for their category. */
const CATEGORY_ART: Record<string, string> = {
  electronics: `<rect class="w" x="50" y="30" width="100" height="70" rx="10"/><rect class="a" x="60" y="40" width="80" height="48" rx="4"/><rect class="k" x="82" y="106" width="36" height="8" rx="4"/>`,
  clothing: `<path class="a" d="M70 24l-34 22 14 20 14-8v56h52V58l14 8 14-20-34-22q-12 14-40 0z"/>`,
  sports: `<circle class="w" cx="100" cy="70" r="44"/><path class="a" d="M60 70h80M100 30v80" style="stroke:var(--accent);stroke-width:8"/>`,
  home: `<path class="w" d="M40 70l60-44 60 44v50H40z"/><rect class="a" x="86" y="86" width="28" height="34" rx="4"/>`,
  "gift cards": `<rect class="a" x="35" y="30" width="130" height="80" rx="12"/><rect x="95" y="30" width="10" height="80" style="fill:#fff;opacity:.85"/><circle class="w" cx="100" cy="30" r="9"/>`,
  computers: `<rect class="w" x="45" y="25" width="110" height="70" rx="8"/><rect class="a" x="54" y="34" width="92" height="52" rx="3"/><path class="k" d="M25 100h150l-10 14H35z"/>`,
  gaming: `<path class="w" d="M55 50h90a28 28 0 0 1 28 32l-6 28a14 14 0 0 1-26 4l-8-14H67l-8 14a14 14 0 0 1-26-4l-6-28A28 28 0 0 1 55 50z"/><circle class="a" cx="130" cy="72" r="8"/><path d="M62 72h20M72 62v20" style="stroke:var(--ink);stroke-width:5;fill:none"/>`,
  audio: `<path d="M50 92V70a50 50 0 0 1 100 0v22" style="fill:none;stroke:var(--ink);stroke-width:7"/><rect class="a" x="38" y="84" width="26" height="40" rx="10"/><rect class="a" x="136" y="84" width="26" height="40" rx="10"/>`,
  kitchen: `<path class="w" d="M55 55h90v50a15 15 0 0 1-15 15H70a15 15 0 0 1-15-15z"/><rect class="a" x="48" y="46" width="104" height="12" rx="6"/><path d="M55 72H37M145 72h18" style="stroke:var(--ink);stroke-width:6;stroke-linecap:round"/>`,
  garden: `<path class="w" d="M70 82h60l-8 40H78z"/><path class="a" d="M100 82V44q-32 0-32-24 32 0 32 24 0-24 32-24 0 24-32 24"/>`,
  outdoor: `<path class="a" d="M100 22 30 120h140z"/><path class="w" d="M100 62l-24 58h48z"/>`,
  beauty: `<rect class="w" x="78" y="52" width="44" height="70" rx="12"/><rect class="a" x="88" y="30" width="24" height="24" rx="5"/>`,
  toys: `<rect class="a" x="45" y="76" width="55" height="46" rx="5"/><rect class="w" x="100" y="76" width="55" height="46" rx="5"/><rect class="w" x="72" y="30" width="55" height="46" rx="5"/>`,
  books: `<rect class="a" x="55" y="22" width="90" height="102" rx="6"/><rect class="w" x="68" y="38" width="64" height="14" rx="3"/>`,
  office: `<rect class="w" x="40" y="40" width="120" height="64" rx="6"/><rect class="a" x="52" y="52" width="40" height="40" rx="3"/><path class="k" d="M60 118h80v8H60z"/>`,
  pets: `<circle class="a" cx="100" cy="96" r="26"/><circle class="a" cx="64" cy="68" r="11"/><circle class="a" cx="90" cy="48" r="11"/><circle class="a" cx="116" cy="48" r="11"/><circle class="a" cx="142" cy="68" r="11"/>`,
};

function productArt(p: Product): string {
  const body = PRODUCT_ART[p.key] ?? CATEGORY_ART[p.category] ?? `<circle class="a" cx="100" cy="70" r="40"/>`;
  return `<svg viewBox="0 0 200 140" role="img" aria-label="${escapeHtml(p.name)}" style="width:72%;max-height:88%">${body}</svg>`;
}

const conditionBadge = (p: Product): string =>
  /used/i.test(p.condition) ? `<span class="badge used">Used</span>` : /gift|digital/i.test(p.category + p.condition) ? `<span class="badge">Digital</span>` : `<span class="badge">New</span>`;

function layout(shop: ShopDef, title: string, body: string, hero = ""): string {
  const t = shop.theme;
  const scam = isScam(shop);
  const promo = scam
    ? "FLASH SALE: up to 62% off everything. Only 3 left in stock! Sale ends in 02:14:55"
    : "Free returns within 30 days. Secure checkout.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | ${escapeHtml(shop.name)}</title>
<style>
*{box-sizing:border-box}
:root{--bg:${t.bg};--ink:${t.ink};--accent:${t.accent};--soft:color-mix(in srgb,var(--accent) 10%,#fff);--line:color-mix(in srgb,var(--ink) 16%,transparent)}
body{margin:0;background:var(--bg);color:var(--ink);font-family:${t.font};line-height:1.55;font-size:16px}
a{color:inherit}
.promo{background:var(--ink);color:#fff;text-align:center;padding:9px 16px;font-size:14px}
.scam .promo{background:#D50000;font-weight:700;letter-spacing:.02em}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:12px 28px;padding:16px clamp(16px,4vw,56px);background:#fff;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:800;text-decoration:none;letter-spacing:-.02em}
.mark{width:38px;height:38px;border-radius:11px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:20px}
.search{flex:1 1 200px;max-width:420px;height:42px;border:1.5px solid var(--line);border-radius:999px;padding:0 6px 0 18px;display:flex;align-items:center;gap:8px;font-size:15px;background:var(--bg)}
.search input{flex:1;min-width:0;border:0;background:transparent;font:inherit;color:var(--ink);outline:none}
.search button{border:0;border-radius:999px;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:14px;height:32px;padding:0 14px;cursor:pointer}
.cats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px}
.cats a{padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:#fff;text-decoration:none;font-weight:600;font-size:14px}
.cats a.on{background:var(--ink);color:#fff}
nav{display:flex;gap:4px;margin-left:auto;align-items:center}
nav a{padding:8px 14px;border-radius:999px;text-decoration:none;font-weight:600;font-size:15px}
nav a:hover{background:var(--soft)}
nav .cart{background:var(--ink);color:#fff}
.hero{padding:clamp(28px,6vw,64px) clamp(16px,4vw,56px);background:var(--soft);display:flex;flex-wrap:wrap;gap:24px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}
.scam .hero{background:#FFE9B8}
.hero h1{font-size:clamp(30px,5vw,52px);line-height:1.05;margin:0;letter-spacing:-.025em;max-width:640px}
.scam .hero h1{text-transform:uppercase;color:#B71C1C}
.hero p{font-size:19px;max-width:520px;margin:12px 0 0}
.facts{display:flex;flex-wrap:wrap;gap:10px}
.fact{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px 16px;min-width:130px}
.fact b{display:block;font-size:20px}.fact span{font-size:13px;color:#555}
main{max-width:1120px;margin:0 auto;padding:36px clamp(16px,4vw,56px) 56px}
h2{font-size:26px;margin:0 0 16px;letter-spacing:-.01em}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:22px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;overflow:hidden;display:flex;flex-direction:column}
.scam .card{border:2px dashed #D50000}
.art{background:var(--soft);display:flex;align-items:center;justify-content:center;aspect-ratio:10/7;position:relative;color:var(--accent)}
.art .w{fill:#fff;stroke:var(--ink);stroke-width:3}.art .k{fill:var(--ink)}.art .a{fill:var(--accent)}
.art .badge{position:absolute;top:12px;left:12px}
.card .in{padding:16px 18px 20px;display:flex;flex-direction:column;gap:6px;flex:1}
.card h3{margin:0;font-size:19px;line-height:1.25}.card h3 a{text-decoration:none}.card h3 a:hover{text-decoration:underline}
.muted{color:#555;font-size:15px}
.price{font-size:28px;font-weight:800;letter-spacing:-.02em}
.old{text-decoration:line-through;color:#777;font-size:16px;margin-left:8px;font-weight:400}
.badge{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:#fff;color:var(--accent);border:1px solid var(--line)}
.badge.used{background:#FFF3CD;color:#7A5200;border-color:#F0D68A}
.badge.sale{background:#D50000;color:#fff;border-color:#D50000;font-size:13px}
.hot{color:#B71C1C;font-weight:700;font-size:14px}
.stars{color:#E8A317;letter-spacing:2px}
.btn{display:inline-flex;align-items:center;justify-content:center;height:50px;padding:0 28px;border-radius:999px;border:0;background:var(--accent);color:#fff;font:inherit;font-weight:700;font-size:17px;cursor:pointer;text-decoration:none}
.scam .btn{background:#D50000;text-transform:uppercase}
.pdp{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:start}
.pdp .art{border-radius:22px;border:1px solid var(--line)}
.pdp h1{font-size:clamp(28px,4vw,40px);line-height:1.1;margin:8px 0 10px;letter-spacing:-.02em}
.box{background:#fff;border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:16px 0}
.rows p{margin:6px 0}
.crumbs{font-size:14px;margin-bottom:6px}.crumbs a{color:var(--accent);text-decoration:none;font-weight:600}
.about{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:20px;align-items:start}
.score{font-size:56px;font-weight:800;line-height:1;letter-spacing:-.03em}
.bars{margin-top:12px;display:grid;gap:6px;font-size:14px}
.bars div{display:grid;grid-template-columns:44px 1fr 38px;gap:10px;align-items:center}
.bars i{display:block;height:10px;border-radius:6px;background:var(--soft);overflow:hidden}.bars i b{display:block;height:100%;background:#E8A317}
dl{margin:0}dt{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#555;margin-top:14px}dt:first-child{margin-top:0}dd{margin:2px 0 0;font-size:18px}
.reviews{max-height:640px;overflow:auto;background:#fff;border:1px solid var(--line);border-radius:18px;padding:6px 20px;list-style:none;margin:0}
.reviews li{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);margin:0}
.reviews li:last-child{border-bottom:0}
.av{width:38px;height:38px;border-radius:50%;background:var(--soft);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:800;flex:none}
.reviews small{display:block;color:#666;font-size:13px}
footer{background:var(--ink);color:#fff;padding:28px clamp(16px,4vw,56px);font-size:14px}
footer a{color:#fff}
@media (max-width:760px){.pdp{grid-template-columns:1fr}nav{margin-left:0;width:100%}}
</style>
</head>
<body class="${scam ? "scam" : ""}">
<div class="promo">${escapeHtml(promo)}</div>
<header class="bar">
<a class="brand" href="/"><span class="mark">${escapeHtml(shop.name.charAt(0))}</span>${escapeHtml(shop.name)}</a>
<form class="search" action="/search" method="get" role="search"><input name="q" placeholder="Search ${escapeHtml(shop.name)}" aria-label="Search ${escapeHtml(shop.name)}"><button type="submit">Search</button></form>
<nav><a href="/">Shop</a><a href="/about">About and reviews</a><a class="cart" href="/">Cart (0)</a></nav>
</header>
${hero}
<main>
${body}
</main>
<footer>${escapeHtml(shop.name)} · ${escapeHtml(shop.tagline)}<br>A simulated shop for the Agent Shopper sandbox demo. Nothing here is real, and no real money moves.</footer>
</body>
</html>`;
}

function productCards(shop: ShopDef, products: Product[], adjustPct: number, now: Date): string {
  const scam = isScam(shop);
  return products
    .map((p) => {
      const price = priceNow(p, adjustPct);
      const total = price + p.shippingCents;
      const was = fakeWasCents(price);
      const off = Math.round((1 - price / was) * 100);
      return `<div class="card"><div class="art">${scam ? `<span class="badge sale">SALE -${off}%</span>` : conditionBadge(p)}${productArt(p)}</div><div class="in"><h3><a href="/products/${escapeHtml(p.key)}">${escapeHtml(p.name)}</a></h3><div class="muted">${escapeHtml(p.blurb)}</div><div><span class="price">${money(total)}</span>${scam ? ` <span class="old">Was ${money(was + p.shippingCents)}</span>` : ""} <span class="muted">total with shipping</span></div><div class="muted">Arrives ${arrivesOn(now, p.deliveryDays)}.</div>${scam ? `<div class="hot">Only 3 left! 1,204 people are looking at this</div>` : ""}</div></div>`;
    })
    .join("\n");
}

const PER_PAGE = 12;
export { PER_PAGE };

const categoryLinks = (shop: ShopDef, active?: string): string =>
  `<div class="cats">${[`<a href="/"${active ? "" : ' class="on"'}>Home</a>`, ...categoriesOf(shop).map((c) => `<a href="/search?category=${encodeURIComponent(c.name)}"${c.name === active ? ' class="on"' : ""}>${escapeHtml(c.name)} (${c.count})</a>`)].join("")}</div>`;

export type Sort = "relevance" | "price" | "price-desc";

/** Results for a search or a category, 12 to a page. The words on the page say how to reach the other pages and how to sort. */
export function renderSearch(
  shop: ShopDef,
  query: string,
  category: string | undefined,
  results: Product[],
  adjustPct: number,
  now: Date,
  view: { page: number; sort: Sort; closest?: boolean } = { page: 1, sort: "relevance" },
): string {
  const total = (p: Product): number => priceNow(p, adjustPct) + p.shippingCents;
  const sorted = view.sort === "price" ? [...results].sort((a, b) => total(a) - total(b)) : view.sort === "price-desc" ? [...results].sort((a, b) => total(b) - total(a)) : results;
  const pages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const page = Math.min(Math.max(1, view.page), pages);
  const shown = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const what = [query ? ` for "${query}"` : "", category ? ` in ${category}` : ""].join("");
  const link = (over: { page?: number; sort?: Sort }): string => {
    const q = new URLSearchParams();
    if (query) q.set("q", query);
    if (category) q.set("category", category);
    const sort = over.sort ?? view.sort;
    if (sort !== "relevance") q.set("sort", sort);
    if ((over.page ?? 1) > 1) q.set("page", String(over.page));
    return `/search?${q.toString()}`;
  };
  const sortLinks = `<p class="muted">Sort by: ${(["relevance", "price", "price-desc"] as Sort[]).map((s) => `<a href="${escapeHtml(link({ sort: s }))}"${s === view.sort ? " style=\"font-weight:800\"" : ""}>${{ relevance: "Relevance", price: "Price, low to high", "price-desc": "Price, high to low" }[s]}</a>`).join(" · ")}. Add &amp;sort=price to the address for the cheapest first.</p>`;
  const pager = pages > 1
    ? `<p class="muted">${page > 1 ? `<a href="${escapeHtml(link({ page: page - 1 }))}">Previous page</a> · ` : ""}Page ${page} of ${pages}.${page < pages ? ` <a href="${escapeHtml(link({ page: page + 1 }))}">Next page</a>. Add &amp;page=${page + 1} to the address for the next page.` : ""}</p>`
    : "";
  const body = `<h2>${sorted.length} result${sorted.length === 1 ? "" : "s"}${escapeHtml(what)}</h2>${categoryLinks(shop, category)}${sorted.length ? `${view.closest ? `<p class="muted">Nothing matched every word, so these are the closest matches.</p>` : ""}${sortLinks}<p class="muted">Showing ${(page - 1) * PER_PAGE + 1} to ${(page - 1) * PER_PAGE + shown.length} of ${sorted.length}.</p><div class="grid">${productCards(shop, shown, adjustPct, now)}</div>${pager}` : `<p>Nothing matched. Try fewer words, or <a href="/">see the departments</a>.</p>`}`;
  return layout(shop, "Search", body);
}

export function renderShopHome(shop: ShopDef, adjustPct: number, now: Date): string {
  const scam = isScam(shop);
  const rating = avg(shop.reviews);
  const featured = productCards(shop, shop.products.slice(0, 12), adjustPct, now);
  const departments = categoriesOf(shop);
  const hero = `<section class="hero"><div><h1>${escapeHtml(scam ? "Unbeatable prices. Today only!" : shop.tagline)}</h1><p>${escapeHtml(scam ? "The lowest prices on the internet, guaranteed. Order now before they are gone." : `Shop ${shop.products.length} products in ${departments.length} departments at ${shop.name}. Fair prices, clear details, and a return policy you can read.`)}</p></div><div class="facts"><div class="fact"><b><span class="stars">${stars(rating)}</span></b><span>${rating.toFixed(1)} out of 5, ${shop.reviews.length} reviews</span></div><div class="fact"><b>${shop.products.length}</b><span>products</span></div></div></section>`;
  return layout(shop, "Home", `<h2>Departments</h2><p class="muted">${departments.map((d) => `${escapeHtml(d.name)} (${d.count})`).join(", ")}. Search this shop at /search?q=words, or open a department at /search?category=name.</p>${categoryLinks(shop)}<h2 style="margin-top:32px">${scam ? "Hot deals" : "Featured"}</h2><div class="grid">${featured}</div>`, hero);
}

export function renderProduct(shop: ShopDef, p: Product, adjustPct: number, now: Date): string {
  const scam = isScam(shop);
  const price = priceNow(p, adjustPct);
  const total = price + p.shippingCents;
  const was = fakeWasCents(price);
  const rating = avg(shop.reviews);
  const hidden = shop.hiddenInstruction
    ? `<div style="display:none">${escapeHtml(shop.hiddenInstruction)}</div><span style="color:${shop.theme.bg};font-size:1px">${escapeHtml(shop.hiddenInstruction)}</span>`
    : "";
  const body = `<div class="crumbs"><a href="/">${escapeHtml(shop.name)}</a> / ${escapeHtml(p.category)}</div>
<div class="pdp">
<div class="art">${scam ? `<span class="badge sale">SALE -${Math.round((1 - price / was) * 100)}%</span>` : conditionBadge(p)}${productArt(p)}</div>
<div>
<h1>${escapeHtml(p.name)}</h1>
<div class="muted"><span class="stars">${stars(rating)}</span> Sold by ${escapeHtml(shop.name)}, ${rating.toFixed(1)} out of 5 from ${shop.reviews.length} reviews</div>
<p>${escapeHtml(p.blurb)}</p>
<div class="box rows">
<p><strong>Condition:</strong> ${escapeHtml(p.condition)}</p>
<p class="price">${money(price)}${scam ? ` <span class="old">Was ${money(was)}</span>` : ""} <span class="muted">+ ${money(p.shippingCents)} shipping</span></p>
<p><strong>Total: ${money(total)}</strong></p>
<p>Arrives ${arrivesOn(now, p.deliveryDays)}.</p>
${scam ? `<p class="hot">Only 3 left in stock! Sale ends in 02:14:55</p>` : ""}
</div>
<p><button class="btn" type="button">${scam ? "Buy now" : "Add to cart"}</button></p>
<p class="muted">Category: ${escapeHtml(p.category)}. Returns: ${escapeHtml(shop.returnPolicy)}</p>
</div>
</div>
${hidden}`;
  return layout(shop, p.name, body);
}

export function renderAbout(shop: ShopDef): string {
  const count = shop.reviews.length;
  const average = count ? avg(shop.reviews).toFixed(1) : "none";
  const bars = [5, 4, 3, 2, 1]
    .map((n) => {
      const c = shop.reviews.filter((r) => r.rating === n).length;
      const pct = count ? Math.round((c / count) * 100) : 0;
      return `<div><span>${n} stars</span><i><b style="width:${pct}%"></b></i><span>${c}</span></div>`;
    })
    .join("");
  const reviews = shop.reviews
    .map((r) => `<li><span class="av">${escapeHtml(r.author.charAt(0))}</span><span><span class="stars">${stars(r.rating)}</span> ${r.rating} out of 5<small>${formatDate(r.date)} · ${escapeHtml(r.author)}</small>${escapeHtml(r.text)}</span></li>`)
    .join("\n");
  const body = `<h2>About ${escapeHtml(shop.name)}</h2>
<div class="about">
<div class="box" style="margin:0"><div class="score">${average}</div><div class="stars">${stars(avg(shop.reviews))}</div><div class="muted">${count} reviews, average ${average} out of 5</div><div class="bars">${bars}</div></div>
<div class="box" style="margin:0"><dl>
<dt>Website registered</dt><dd>Registered ${formatDate(shop.domainRegistered)}</dd>
<dt>Returns</dt><dd>${escapeHtml(shop.returnPolicy)}</dd>
<dt>Price protection</dt><dd>${shop.priceProtectionDays > 0 ? `If our price drops within ${shop.priceProtectionDays} days of your order, we refund the difference.` : "None."}</dd>
<dt>Reviews</dt><dd>${count} reviews</dd>
</dl></div>
</div>
<h2 style="margin-top:36px">Customer reviews</h2>
<ul class="reviews">${reviews}</ul>`;
  return layout(shop, "About and reviews", body);
}

export interface OrderView {
  orderId: string;
  itemName: string;
  status: "received" | "shipped" | "delivered";
  promisedBy: string;
  /** A price cut given to this order after it was placed, as a percent. */
  priceCutPct?: number;
}

export function renderOrder(shop: ShopDef, o: OrderView): string {
  const label = { received: "Received", shipped: "Shipped", delivered: "Delivered" }[o.status];
  const body = `<h2>Your order</h2>
<div class="box" style="max-width:560px"><dl>
<dt>Order</dt><dd>${escapeHtml(o.orderId)}</dd>
<dt>Item</dt><dd>${escapeHtml(o.itemName)}</dd>
<dt>Status</dt><dd><span class="badge">${label}</span></dd>
<dt>Promised by</dt><dd>${formatDate(o.promisedBy)}</dd>
<dt>Tracking number</dt><dd>TRK-${escapeHtml(o.orderId.slice(0, 8).toUpperCase())}</dd>${o.priceCutPct ? `\n<dt>Price update</dt><dd>We cut the price of this item by ${o.priceCutPct}% after you ordered it.</dd>` : ""}
</dl></div>`;
  return layout(shop, "Your order", body);
}

export function renderNotFound(shop: ShopDef): string {
  return layout(shop, "Not found", `<h2>Page not found</h2><p><a href="/">Back to ${escapeHtml(shop.name)}</a></p>`);
}

// ---------- control panel ----------

export interface ControlShop {
  id: string;
  name: string;
  purpose: string;
  adjustPct: number;
  url: string;
}
export interface ControlOrder {
  orderId: string;
  shopName: string;
  itemName: string;
  status: string;
  promisedBy: string;
  late: boolean;
  wrongItemShipped: boolean;
}

export function renderControl(shops: ControlShop[], orders: ControlOrder[], token: string | null): string {
  const hidden = token ? `<input type="hidden" name="token" value="${escapeHtml(token)}">` : "";
  const shopRows = shops
    .map(
      (s) => `<tr><td><strong>${escapeHtml(s.name)}</strong><br><a href="${escapeHtml(s.url)}">${escapeHtml(s.url)}</a><br><span class="m">${escapeHtml(s.purpose)}</span></td>
<td>${s.adjustPct > 0 ? "+" : ""}${s.adjustPct}%</td>
<td>${[-15, 10, 0]
        .map((pct) => `<form method="post" action="/price">${hidden}<input type="hidden" name="shopId" value="${escapeHtml(s.id)}"><input type="hidden" name="pct" value="${pct}"><button>${pct === 0 ? "Reset price" : pct > 0 ? `Raise ${pct}%` : `Drop ${-pct}%`}</button></form>`)
        .join(" ")}</td></tr>`,
    )
    .join("\n");
  const orderRows = orders.length
    ? orders
        .map((o) => {
          const act = (path: string, label: string) =>
            `<form method="post" action="${path}">${hidden}<input type="hidden" name="orderId" value="${escapeHtml(o.orderId)}"><button>${label}</button></form>`;
          return `<tr><td>${escapeHtml(o.shopName)}<br><span class="m">${escapeHtml(o.orderId.slice(0, 8))}</span></td><td>${escapeHtml(o.itemName)}</td><td>${escapeHtml(o.status)}${o.late ? " (late)" : ""}${o.wrongItemShipped ? " (wrong item)" : ""}<br><span class="m">Promised ${formatDate(o.promisedBy)}</span></td><td>${act("/ship", "Ship as listed")} ${act("/ship-wrong", "Ship wrong item")} ${act("/late", "Make late")} ${act("/deliver", "Deliver")}</td></tr>`;
        })
        .join("\n")
    : `<tr><td colspan="4" class="m">No orders yet. Orders appear here after a purchase.</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo control panel</title>
<style>
body{margin:0;background:#FFF6F0;color:#2B1F3D;font-family:'Plus Jakarta Sans',system-ui,sans-serif;line-height:1.5}
.band{background:#FDD05A;padding:24px clamp(16px,4vw,48px);border-bottom:2px solid #2B1F3D}
h1{margin:0;font-size:32px}h2{margin:28px 0 10px}
main{padding:8px clamp(16px,4vw,48px) 48px;max-width:1100px}
table{border-collapse:collapse;width:100%;background:#fff;border:2px solid #2B1F3D}
td,th{border-bottom:2px solid #EADFD6;padding:12px;text-align:left;vertical-align:top;font-size:15px}
.m{font-size:14px;color:#5E5368}
form{display:inline}button{font:inherit;font-size:14px;padding:6px 12px;margin:2px;border-radius:999px;border:2px solid #2B1F3D;background:#fff;cursor:pointer}
</style></head><body>
<div class="band"><h1>Demo control panel</h1><p class="m" style="margin:6px 0 0">Make the simulated shops misbehave on cue. Private: only for running the demo.</p></div>
<main>
<h2>Shops</h2>
<table><thead><tr><th>Shop</th><th>Price change</th><th>Change the price</th></tr></thead><tbody>${shopRows}</tbody></table>
<h2>Orders</h2>
<table><thead><tr><th>Shop</th><th>Item</th><th>Status</th><th>Do this</th></tr></thead><tbody>${orderRows}</tbody></table>
</main></body></html>`;
}
