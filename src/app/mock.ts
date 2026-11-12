// A scripted shopper for trying the app without spending money (MOCK_SERVICES=1) and for tests.
// It is NOT an AI: it picks the cheapest matching listing first, which makes the guard turn the scam shop
// down, then proposes the next cheapest. The screens say "mock mode" whenever this is in use.

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelPort } from "../agent/shopper.ts";
import { SHOPS, searchProducts, searchShop } from "../shops/catalog.ts";
import { headNoun, keywords, searchLadder } from "../shared/words.ts";

type Params = Anthropic.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;

let counter = 0;
const reply = (content: Block[], stop: "tool_use" | "end_turn" = "tool_use"): Anthropic.Message =>
  ({ id: `mock_${++counter}`, type: "message", role: "assistant", model: "mock", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Message;
const use = (name: string, input: unknown): Block => ({ type: "tool_use", id: `tu_${++counter}`, name, input });

/** delayMs makes the scripted shopper take a moment per step, so the live screens look like a real run. Tests use none. */
/** The scripted version of the message the shopper drafts about an order problem, built from the evidence it is given. */
function mockDraft(params: Params): string {
  const first = params.messages[0]!.content;
  const marker = "Evidence (JSON):\n";
  const text = typeof first === "string" ? first : "";
  const json = text.includes(marker) ? text.slice(text.indexOf(marker) + marker.length) : "{}";
  let e: any = {};
  try {
    e = JSON.parse(json);
  } catch {
    // An unreadable payload gives a plain message below.
  }
  const o = e.evidence?.order ?? {};
  const paid = typeof o.paidCents === "number" ? `$${(o.paidCents / 100).toFixed(2)}` : "the amount paid";
  const ask = e.askingFor ?? "a refund";
  const why = e.kind === "wrong_item" ? `The shop's delivery record lists "${e.evidence?.arrived?.description ?? "a different item"}" for this order, which is not what I ordered.` : e.summary ?? "There is a problem with this order.";
  return `Hello ${o.shop ?? "team"}, I ordered "${o.item ?? "an item"}" and paid ${paid}. ${why} Your policy says: ${String(e.evidence?.shopPolicy?.returns ?? "see your returns page").replace(/\.$/, "")}. I am asking for ${ask}. The saved listing page, the order record and the payment timeline are attached. Thank you.`;
}

/** What the conversation shows so far: pages opened, proposals made, which were turned down or accepted. */
function readHistory(params: Params) {
  const ids = new Map<string, string>(); // page url -> snapshot id
  const proposed = new Map<string, string>(); // tool_use id -> snapshot id
  const turnedDown = new Set<string>();
  const accepted = new Set<string>(); // snapshot ids whose proposal was accepted
  const sellersChecked = new Set<string>();
  const checkIds = new Map<string, string>(); // tool_use id -> shop id
  for (const m of params.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "tool_use" && b.name === "propose_purchase") proposed.set(b.id, String((b.input as { snapshot_id?: string }).snapshot_id));
      if (b.type === "tool_use" && b.name === "check_seller") checkIds.set(b.id, String((b.input as { shop_id?: string }).shop_id));
      if (b.type === "tool_result") {
        const data = JSON.parse(String(b.content)) as { snapshot_id?: string; url?: string; accepted?: boolean };
        if (data.snapshot_id && data.url) ids.set(data.url, data.snapshot_id);
        if (b.is_error && proposed.has(b.tool_use_id)) turnedDown.add(proposed.get(b.tool_use_id)!);
        if (!b.is_error && data.accepted && proposed.has(b.tool_use_id)) accepted.add(proposed.get(b.tool_use_id)!);
        if (!b.is_error && checkIds.has(b.tool_use_id)) sellersChecked.add(checkIds.get(b.tool_use_id)!);
      }
    }
  }
  return { ids, proposed, turnedDown, accepted, sellersChecked };
}

/** The scripted gift shopper: searches each shop for the person's interests, opens the best matches, and puts forward three different ones. */
function giftTurn(params: Params, system: string, shops: Array<{ id: string; baseUrl: string }>): Anthropic.Message {
  const budget = Math.round(Number(/Most they will pay for the gift, with shipping: \$([0-9.]+)/.exec(system)?.[1] ?? "0") * 100);
  const likes = /^What they like: (.+)$/m.exec(system)?.[1] ?? "";
  const terms = [...new Set(likes.startsWith("not said") ? [] : likes.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3))].slice(0, 4);
  if (terms.length === 0) terms.push("gift");

  // Per interest, the cheapest matching new items first (so the too-cheap shop is tried and turned down), then taken in turns across interests.
  const perTerm = terms.map((t) =>
    shops
      .flatMap((s) => {
        const def = SHOPS.find((d) => d.id === s.id);
        return (def ? searchProducts(def, t) : []).map((p) => ({ shop: s, product: p }));
      })
      .filter(({ product }) => product.category !== "gift cards" && !/used|refurbished|opened/i.test(product.condition) && product.priceCents + product.shippingCents <= budget)
      .sort((a, b) => a.product.priceCents + a.product.shippingCents - (b.product.priceCents + b.product.shippingCents)),
  );
  const candidates: Array<(typeof perTerm)[number][number]> = [];
  const seen = new Set<string>();
  for (let i = 0; candidates.length < 8 && perTerm.some((l) => i < l.length); i++) {
    for (const list of perTerm) {
      const c = list[i];
      if (c && !seen.has(`${c.shop.id}/${c.product.key}`) && candidates.length < 8) {
        seen.add(`${c.shop.id}/${c.product.key}`);
        candidates.push(c);
      }
    }
  }

  const { ids, proposed, turnedDown, accepted, sellersChecked } = readHistory(params);
  if (params.messages.length === 1) {
    return reply(shops.map((s) => use("open_page", { url: `${s.baseUrl}/search?q=${encodeURIComponent(terms[0]!)}` })));
  }
  if (candidates.length === 0) return reply([use("give_up", { reason: "I could not find a suitable gift in these shops." })]);

  const urlOf = (c: (typeof candidates)[number]) => `${c.shop.baseUrl}/products/${c.product.key}`;
  const unopened = candidates.filter((c) => !ids.has(urlOf(c)));
  const toCheck = [...new Set(candidates.map((c) => c.shop.id))].filter((id) => !sellersChecked.has(id));
  if (unopened.length || toCheck.length) {
    return reply([...unopened.map((c) => use("open_page", { url: urlOf(c) })), ...toCheck.map((id) => use("check_seller", { shop_id: id }))]);
  }

  // Put forward ideas that have not been tried, never the same product twice.
  const acceptedKeys = new Set(candidates.filter((c) => accepted.has(ids.get(urlOf(c))!)).map((c) => c.product.key));
  const tried = new Set([...proposed.values()]);
  const next = candidates.filter((c) => !tried.has(ids.get(urlOf(c))!));
  const batch: typeof candidates = [];
  for (const c of next) {
    if (acceptedKeys.has(c.product.key) || batch.some((b) => b.product.key === c.product.key)) continue;
    if (batch.length + accepted.size < 3) batch.push(c);
  }
  if (batch.length) {
    return reply(
      batch.map((c) =>
        use("propose_purchase", {
          snapshot_id: ids.get(urlOf(c)),
          reasoning: `Suits someone who likes ${terms.find((t) => `${c.product.name} ${c.product.blurb} ${c.product.category}`.toLowerCase().includes(t)) ?? terms[0]}, and fits the budget comfortably.`,
          claims: [
            { rule: "item", quote: c.product.name },
            { rule: "condition", quote: c.product.condition.replace(/\.$/, "") },
          ],
        }),
      ),
    );
  }
  void turnedDown;
  return accepted.size > 0
    ? reply([use("finish_picks", { summary: `Found ${accepted.size} gift idea${accepted.size === 1 ? "" : "s"} to suit them.` })])
    : reply([use("give_up", { reason: "Every idea I found was turned down." })]);
}

export function createMockModel(opts: { delayMs?: number } = {}): ModelPort {
  return async (params: Params) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const system = typeof params.system === "string" ? params.system : "";
    const shops = [...system.matchAll(/^- ([a-z-]+): (http\S+)$/gm)].map((m) => ({ id: m[1]!, baseUrl: m[2]! }));
    if (system.includes("order problem")) return reply([{ type: "text", text: mockDraft(params) }], "end_turn");
    if (system.includes("This is a gift request")) return giftTurn(params, system, shops);
    const first = params.messages[0]!.content;
    const item = (/Find this for me: (.+?)\. Start by/.exec(typeof first === "string" ? first : "")?.[1] ?? "").toLowerCase();

    // What was searched so far, in order. The first search that finds anything is the one to buy from.
    const tried: string[] = [];
    for (const m of params.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type !== "tool_use" || b.name !== "open_page") continue;
        const u = new URL(String((b.input as { url?: string }).url));
        if (!u.pathname.endsWith("/search")) continue;
        // A department listing is a try too, but it is only browsing: it never finds the item.
        const q = u.searchParams.has("category") ? `dept:${u.searchParams.get("category")}` : (u.searchParams.get("q") ?? "").toLowerCase();
        if (!tried.includes(q)) tried.push(q);
      }
    }
    const listingsFor = (q: string) =>
      shops.flatMap((s) => {
        const def = SHOPS.find((d) => d.id === s.id);
        return (def ? searchShop(def, q).products : []).map((p) => ({ shop: s, product: p }));
      });
    const hitAt = tried.find((q) => !q.startsWith("dept:") && listingsFor(q).length > 0);

    // Listings from that search (the same one the shops offer), cheapest first. If some of them ARE the item (a laptop) and others
    // only carry its name (a laptop sleeve, a laptop stand), only the real ones count, even when they are too dear: it gives up
    // rather than buying an accessory. When none is clearly the item, every match counts, as before.
    const found = hitAt === undefined ? [] : listingsFor(hitAt);
    const wanted = new Set(keywords(item));
    const itself = found.filter(({ product }) => wanted.has(headNoun(product.name)));
    const candidates = (itself.length > 0 ? itself : found).sort(
      (a, b) => a.product.priceCents + a.product.shippingCents - (b.product.priceCents + b.product.shippingCents),
    );

    if (params.messages.length === 1) return reply(shops.map((s) => use("open_page", { url: `${s.baseUrl}/search?q=${encodeURIComponent(item)}` })));
    if (candidates.length === 0) {
      // Nothing yet: search again with simpler words, then browse departments, so at least three tries are made.
      const more = [...searchLadder(item), "dept:electronics", "dept:sports"].find((q) => !tried.includes(q));
      if (tried.length < 3 && more !== undefined) {
        const param = more.startsWith("dept:") ? `category=${encodeURIComponent(more.slice(5))}` : `q=${encodeURIComponent(more)}`;
        return reply(shops.map((s) => use("open_page", { url: `${s.baseUrl}/search?${param}` })));
      }
      return reply([use("give_up", { reason: "I could not find that in these shops." })]);
    }

    // Read what happened so far: pages opened, and which proposals were turned down.
    const ids = new Map<string, string>(); // product page url -> snapshot id
    const proposed = new Map<string, string>(); // tool_use id -> snapshot id
    const turnedDown = new Set<string>();
    for (const m of params.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) {
        if (b.type === "tool_use" && b.name === "propose_purchase") proposed.set(b.id, String((b.input as { snapshot_id?: string }).snapshot_id));
        if (b.type === "tool_result") {
          const data = JSON.parse(String(b.content)) as { snapshot_id?: string; url?: string };
          if (data.snapshot_id && data.url) ids.set(data.url, data.snapshot_id);
          if (b.is_error && proposed.has(b.tool_use_id)) turnedDown.add(proposed.get(b.tool_use_id)!);
        }
      }
    }

    const urlOf = (c: (typeof candidates)[number]) => `${c.shop.baseUrl}/products/${c.product.key}`;
    const unopened = candidates.filter((c) => !ids.has(urlOf(c)));
    if (unopened.length) {
      const sellers = [...new Set(candidates.map((c) => c.shop.id))];
      return reply([...unopened.map((c) => use("open_page", { url: urlOf(c) })), ...sellers.map((id) => use("check_seller", { shop_id: id }))]);
    }
    const next = candidates.find((c) => !turnedDown.has(ids.get(urlOf(c))!));
    if (!next) return reply([use("give_up", { reason: "Every matching listing was turned down." })]);
    return reply([
      use("propose_purchase", {
        snapshot_id: ids.get(urlOf(next)),
        reasoning: "Cheapest listing I have not been turned down on yet.",
        claims: [
          { rule: "item", quote: next.product.name },
          { rule: "condition", quote: next.product.condition.replace(/\.$/, "") },
        ],
      }),
    ]);
  };
}
