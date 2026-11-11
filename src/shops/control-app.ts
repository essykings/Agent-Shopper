// The private demo control panel: makes the simulated shops misbehave on cue.
// If a token is set, every request needs it. Keep it private: it can change shop prices.

import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Pool } from "../server/db.ts";
import { SHOPS, findProduct, findShop } from "./catalog.ts";
import { renderControl } from "./pages.ts";
import type { ControlOrder, ControlShop } from "./pages.ts";
import { ShopControlError, deliverOrder, getPriceAdjust, listShopOrders, markLate, setPriceAdjust, shipOrder } from "./service.ts";

export interface ControlOptions {
  token?: string;
  now?: () => Date;
  /** Where each shop lives, shown as a link. */
  shopUrl?: (shopId: string) => string;
}

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

export function createControlApp(pool: Pool, opts: ControlOptions = {}): Hono {
  const app = new Hono();
  const now = (): Date => (opts.now ?? (() => new Date()))();

  app.use("*", async (c, next) => {
    if (!opts.token) return next();
    const supplied = c.req.method === "POST" ? String((await c.req.parseBody())["token"] ?? "") : (c.req.query("token") ?? "");
    if (!sameToken(supplied, opts.token)) return c.text("The control panel needs the right token.", 401);
    return next();
  });

  const back = (c: Context) => c.redirect(`/${opts.token ? `?token=${encodeURIComponent(opts.token)}` : ""}`, 303);

  async function act(c: Context, run: (body: Record<string, string>) => Promise<void>) {
    const raw = await c.req.parseBody();
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) body[k] = String(v);
    try {
      await run(body);
    } catch (err) {
      if (err instanceof ShopControlError) return c.text(err.message, 400);
      throw err;
    }
    return back(c);
  }

  app.get("/", async (c) => {
    const shops: ControlShop[] = [];
    for (const s of SHOPS) {
      shops.push({ id: s.id, name: s.name, purpose: s.purpose, adjustPct: await getPriceAdjust(pool, s.id), url: opts.shopUrl?.(s.id) ?? "" });
    }
    const today = now().toISOString().slice(0, 10);
    const orders: ControlOrder[] = (await listShopOrders(pool)).map((o) => {
      const shop = findShop(o.shopId);
      return {
        orderId: o.orderId,
        shopName: shop?.name ?? o.shopId,
        itemName: (shop && findProduct(shop, o.itemKey)?.name) ?? o.itemKey,
        status: o.status,
        promisedBy: o.promisedBy,
        late: o.status !== "delivered" && o.promisedBy < today,
        wrongItemShipped: o.shippedItem !== null,
      };
    });
    return c.html(renderControl(shops, orders, opts.token ?? null));
  });

  app.post("/price", (c) =>
    act(c, async (b) => {
      if (!/^-?\d+$/.test(b["pct"] ?? "")) throw new ShopControlError("The price change must be a whole number.");
      await setPriceAdjust(pool, b["shopId"] ?? "", Number(b["pct"]));
    }),
  );
  app.post("/ship", (c) => act(c, (b) => shipOrder(pool, b["orderId"] ?? "", false)));
  app.post("/ship-wrong", (c) => act(c, (b) => shipOrder(pool, b["orderId"] ?? "", true)));
  app.post("/late", (c) => act(c, (b) => markLate(pool, b["orderId"] ?? "", now())));
  app.post("/deliver", (c) => act(c, (b) => deliverOrder(pool, b["orderId"] ?? "")));

  return app;
}
