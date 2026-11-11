import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBaseUrl } from "./urls.ts";

test("a private address from Render, with no scheme, is read as http", () => {
  assert.equal(normalizeBaseUrl("shop-northgear:10000"), "http://shop-northgear:10000");
  assert.equal(normalizeBaseUrl("  shop-northgear:10000  "), "http://shop-northgear:10000");
  assert.equal(normalizeBaseUrl("shop-northgear"), "http://shop-northgear");
});

test("addresses that already have a scheme are kept, and only the scheme and host remain", () => {
  assert.equal(normalizeBaseUrl("http://northgear.localhost:4101"), "http://northgear.localhost:4101");
  assert.equal(normalizeBaseUrl("https://northgear.onrender.com/"), "https://northgear.onrender.com");
  assert.equal(normalizeBaseUrl("https://northgear.onrender.com/some/path?x=1#y"), "https://northgear.onrender.com");
});

test("anything that is not a plain http or https address is refused", () => {
  for (const bad of ["", "   ", "ftp://shop", "file:///etc/passwd", "javascript:alert(1)", "http://user:pass@shop:1", "http://", "http://bad host"]) {
    assert.throws(() => normalizeBaseUrl(bad), Error, JSON.stringify(bad));
  }
});
