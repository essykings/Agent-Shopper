// Starts the demo shops.
//   On Render: one service per shop, each with SHOP_ID=northgear (or deal-zone, trailhead) and PORT set by Render.
//   One more service with CONTROL=1 and CONTROL_TOKEN runs the owner's control panel.
//   On your machine: SHOPS_LOCAL=1 starts all three shops and the control panel on fixed ports.

import { serve } from "@hono/node-server";
import { createPool, migrate } from "../server/db.ts";
import { SHOPS, findShop } from "./catalog.ts";
import { createControlApp } from "./control-app.ts";
import { createShopApp } from "./shop-app.ts";
import { seedShops } from "./service.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Add it to .env (see .env.example).");
  process.exit(1);
}

const pool = createPool(databaseUrl);
await migrate(pool);
await seedShops(pool, process.env.SHOP_PAYEE_EMAIL ?? "shops@example.com");

const shopId = process.env.SHOP_ID;
const local = process.env.SHOPS_LOCAL === "1";

if (shopId) {
  const shop = findShop(shopId);
  if (!shop) {
    console.error(`Unknown SHOP_ID "${shopId}". Use one of: ${SHOPS.map((s) => s.id).join(", ")}.`);
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4000);
  serve({ fetch: createShopApp(pool, shop).fetch, port });
  console.log(`${shop.name} is open on port ${port}.`);
} else if (process.env.CONTROL === "1") {
  // The owner's control panel in the cloud. It can change shop prices, so it will not start without a password.
  const token = process.env.CONTROL_TOKEN?.trim();
  if (process.env.NODE_ENV === "production" && (!token || token.length < 12)) {
    console.error("CONTROL_TOKEN must be set to at least 12 characters when NODE_ENV=production.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4100);
  serve({ fetch: createControlApp(pool, token ? { token } : {}).fetch, port });
  console.log(`The control panel is open on port ${port}.`);
} else if (local) {
  const CONTROL_PORT = 4100;
  const ports = new Map(SHOPS.map((s, i) => [s.id, 4101 + i]));
  for (const s of SHOPS) serve({ fetch: createShopApp(pool, s).fetch, port: ports.get(s.id)! });
  const token = process.env.CONTROL_TOKEN || undefined;
  serve({ fetch: createControlApp(pool, { ...(token ? { token } : {}), shopUrl: (id) => `http://${id}.localhost:${ports.get(id)}` }).fetch, port: CONTROL_PORT });
  console.log("Demo shops are open:");
  for (const s of SHOPS) console.log(`  ${s.name.padEnd(10)} http://${s.id}.localhost:${ports.get(s.id)}`);
  console.log(`  Control    http://localhost:${CONTROL_PORT}${token ? `/?token=${token}` : ""}`);
} else {
  console.error("Set SHOP_ID to run one shop, CONTROL=1 to run the control panel, or SHOPS_LOCAL=1 to run all three locally.");
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void pool.end().finally(() => process.exit(0));
  });
}
