// One demo shop as a small website of its own: its own pages, its own prices and orders. It can run on an address
// of its own, or under a path of the main app (see base-path.ts).

import { Hono } from "hono";
import type { Pool } from "../server/db.ts";
import { underPrefix } from "./base-path.ts";
import { findProduct, searchShop } from "./catalog.ts";
import type { ShopDef } from "./catalog.ts";
import { renderAbout, renderNotFound, renderOrder, renderProduct, renderSearch, renderShopHome } from "./pages.ts";
import type { Sort } from "./pages.ts";
import { getPriceAdjust, getShopOrder } from "./service.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** basePath is where the shop lives inside a bigger site, for example "/shops/northgear". Empty means it has an address of its own. */
export function createShopApp(pool: Pool, shop: ShopDef, opts: { now?: () => Date; basePath?: string } = {}): Hono {
  const app = new Hono();
  underPrefix(app, opts.basePath ?? "");
  const now = (): Date => (opts.now ?? (() => new Date()))();

  // Prices change from the control panel, so nothing here may be cached.
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.get("/health", (c) => c.text("ok"));

  app.get("/", async (c) => c.html(renderShopHome(shop, await getPriceAdjust(pool, shop.id), now())));

  app.get("/products/:key", async (c) => {
    const product = findProduct(shop, c.req.param("key"));
    if (!product) return c.html(renderNotFound(shop), 404);
    return c.html(renderProduct(shop, product, await getPriceAdjust(pool, shop.id), now()));
  });

  app.get("/search", async (c) => {
    const q = (c.req.query("q") ?? "").slice(0, 80);
    const category = c.req.query("category")?.slice(0, 40) || undefined;
    const sortParam = c.req.query("sort");
    const sort: Sort = sortParam === "price" || sortParam === "price-desc" ? sortParam : "relevance";
    const page = Math.min(Math.max(Number.parseInt(c.req.query("page") ?? "1", 10) || 1, 1), 1000);
    const found = searchShop(shop, q, category);
    return c.html(renderSearch(shop, q, category, found.products, await getPriceAdjust(pool, shop.id), now(), { page, sort, closest: !found.exact }));
  });

  app.get("/about", (c) => c.html(renderAbout(shop)));

  app.get("/orders/:orderId", async (c) => {
    const id = c.req.param("orderId");
    if (!UUID.test(id)) return c.html(renderNotFound(shop), 404);
    const order = await getShopOrder(pool, id);
    const product = order && order.shopId === shop.id ? findProduct(shop, order.itemKey) : undefined;
    if (!order || !product) return c.html(renderNotFound(shop), 404);
    return c.html(renderOrder(shop, { orderId: order.orderId, itemName: product.name, status: order.status, promisedBy: order.promisedBy }));
  });

  app.notFound((c) => c.html(renderNotFound(shop), 404));
  return app;
}
