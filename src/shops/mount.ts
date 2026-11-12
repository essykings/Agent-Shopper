// All the demo shops, and the owner's control panel, as one small app that the main app mounts:
//   /shops/northgear, /shops/deal-zone, /shops/trailhead   the shops
//   /control                                               the control panel (only if a token is given, or locally)
// The agent reads these pages inside the same process, so no extra services are needed.

import { Hono } from "hono";
import type { Pool } from "../server/db.ts";
import { SHOPS } from "./catalog.ts";
import { createControlApp } from "./control-app.ts";
import { createShopApp } from "./shop-app.ts";

export const SHOP_PREFIX = "/shops";
export const CONTROL_PREFIX = "/control";

export interface MountOptions {
  now?: () => Date;
  /** Password for the control panel. Without one the panel is not served, unless allowOpenControl is set (local use). */
  controlToken?: string;
  allowOpenControl?: boolean;
  /** The address people use to reach the app, so the panel can link to each shop. */
  publicUrl: string;
}

export function createShopsApp(pool: Pool, opts: MountOptions): Hono {
  // Not strict about a trailing slash, so /shops/northgear and /shops/northgear/ are the same page.
  const app = new Hono({ strict: false });
  const now = opts.now ? { now: opts.now } : {};
  for (const shop of SHOPS) app.route(`${SHOP_PREFIX}/${shop.id}`, createShopApp(pool, shop, { ...now, basePath: `${SHOP_PREFIX}/${shop.id}` }));
  if (opts.controlToken || opts.allowOpenControl) {
    app.route(
      CONTROL_PREFIX,
      createControlApp(pool, { ...now, ...(opts.controlToken ? { token: opts.controlToken } : {}), basePath: CONTROL_PREFIX, shopUrl: (id) => `${opts.publicUrl}${SHOP_PREFIX}/${id}` }),
    );
  }
  return app;
}

/** The address of one shop on the app, for example http://localhost:3000/shops/northgear. */
export const shopAddress = (publicUrl: string, shopId: string): string => `${publicUrl.replace(/\/$/, "")}${SHOP_PREFIX}/${shopId}`;
