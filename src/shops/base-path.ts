// Lets a shop (or the control panel) live under a path of the main app, such as /shops/northgear, instead of on
// its own address. The pages are written with links like "/products/earbuds", so when a path prefix is used every
// root link in the HTML is moved under it. Pages also get a strict content policy: they are plain pages with no
// scripts, so a scam shop's page can never run code next to the app's sign-in.

import type { Hono } from "hono";

const ROOT_LINK = /\b(href|action|src)=(["'])\/(?!\/)/gi;

/** Moves every root-relative link (href="/x", action="/x") under the prefix. A prefix of "" changes nothing. */
export function prefixLinks(html: string, prefix: string): string {
  return prefix ? html.replace(ROOT_LINK, (_m, attr: string, quote: string) => `${attr}=${quote}${prefix}/`) : html;
}

/** What a page may load: its own style and inline pictures, and nothing that runs. */
export const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** Adds the prefix to links, redirects and the content policy, for every response of an app. */
export function underPrefix(app: Hono, prefix: string): void {
  app.use("*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", PAGE_POLICY);
    c.header("X-Content-Type-Options", "nosniff");
    if (!prefix) return;
    const location = c.res.headers.get("location");
    if (location && location.startsWith("/") && !location.startsWith("//")) c.header("Location", `${prefix}${location}`);
    if ((c.res.headers.get("content-type") ?? "").includes("text/html")) {
      const body = prefixLinks(await c.res.text(), prefix);
      const headers = new Headers(c.res.headers);
      headers.delete("content-length");
      c.res = new Response(body, { status: c.res.status, headers });
    }
  });
}
