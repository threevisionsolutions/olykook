import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/server.js";
import { barcodeKey, groupSameProduct, interleave, searchAll, sortProducts } from "../src/services/search.js";
import type { Product, Provider, SourceId } from "../src/types.js";
import { clearEnv, mockFetch, setEnv } from "./helpers.js";

beforeEach(clearEnv);
afterEach(() => vi.unstubAllGlobals());

const product = (source: SourceId, id: string, extra: Partial<Product> = {}): Product => ({
  id: `${source}:${id}`, source, sourceId: id, store: source, title: `${source} ${id}`, url: `https://${source}.test/${id}`, via: "api", ...extra,
});

const fake = (id: SourceId, impl: () => Promise<Product[]>, configured = true): Provider => ({
  id, name: id, setup: "", isConfigured: () => configured, search: impl,
});

describe("searchAll", () => {
  it("keeps going when one store fails, and reports each store's status", async () => {
    const result = await searchAll({ query: "kettle" }, {
      providerList: [
        fake("amazon", async () => [product("amazon", "a1"), product("amazon", "a2")]),
        fake("ebay", async () => { throw new Error("HTTP 500"); }),
        fake("walmart", async () => [product("walmart", "w1")]),
        fake("etsy", async () => [], false),
      ],
    });
    expect(result.products.map((p) => p.id)).toEqual(["amazon:a1", "walmart:w1", "amazon:a2"]);
    expect(result.providers.map((r) => [r.provider, r.status])).toEqual([
      ["amazon", "ok"], ["ebay", "error"], ["walmart", "ok"], ["etsy", "skipped"],
    ]);
    expect(result.providers[1].error).toBe("HTTP 500");
  });

  it("only searches the stores asked for", async () => {
    const ebaySearch = vi.fn(async () => []);
    await searchAll({ query: "x" }, { sources: ["amazon"], providerList: [fake("amazon", async () => []), fake("ebay", ebaySearch)] });
    expect(ebaySearch).not.toHaveBeenCalled();
  });
});

describe("merging results", () => {
  it("interleaves stores", () => {
    expect(interleave([[product("amazon", "1"), product("amazon", "2")], [product("ebay", "1")]]).map((p) => p.id)).toEqual([
      "amazon:1", "ebay:1", "amazon:2",
    ]);
  });

  it("sorts by price with unpriced items last, and by rating weighted by review count", () => {
    const items = [
      product("amazon", "pricey", { price: { amount: 50, currency: "USD" }, rating: 4.7, reviewCount: 10_000 }),
      product("ebay", "none"),
      product("walmart", "cheap", { price: { amount: 10, currency: "USD" }, rating: 5, reviewCount: 1 }),
    ];
    expect(sortProducts(items, "price_asc").map((p) => p.sourceId)).toEqual(["cheap", "pricey", "none"]);
    expect(sortProducts(items, "price_desc").map((p) => p.sourceId)).toEqual(["pricey", "cheap", "none"]);
    expect(sortProducts(items, "rating")[0].sourceId).toBe("pricey");
  });

  it("groups the same barcode across stores (UPC and EAN forms match)", () => {
    expect(barcodeKey(product("amazon", "1", { identifiers: { upc: "194253939207" } }))).toBe("00194253939207");
    const groups = groupSameProduct([
      product("amazon", "1", { identifiers: { upc: "194253939207" }, price: { amount: 199, currency: "USD" } }),
      product("walmart", "2", { identifiers: { ean: "0194253939207" }, price: { amount: 189, currency: "USD" } }),
      product("ebay", "3", { identifiers: { gtin: "000000000000" } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers.map((o) => o.store)).toEqual(["walmart", "amazon"]);
  });
});

describe("HTTP API", () => {
  it("lists stores and how to connect them", async () => {
    setEnv({ BESTBUY_API_KEY: "x" });
    const res = await app.request("/api/providers");
    const body = await res.json();
    expect(body.providers.find((p: any) => p.id === "bestbuy").configured).toBe(true);
    expect(body.providers.find((p: any) => p.id === "ebay")).toMatchObject({ configured: false, imageSearch: true });
  });

  it("validates search input", async () => {
    expect((await app.request("/api/search")).status).toBe(400);
    expect((await app.request("/api/search?q=x&sources=nope")).status).toBe(400);
    expect((await app.request("/api/search?q=x&sort=cheapest")).status).toBe(400);
  });

  it("runs a search end to end", async () => {
    setEnv({ BESTBUY_API_KEY: "x" });
    mockFetch([[/bestbuy/, () => ({ json: { products: [{ sku: 1234567, name: "Toaster", salePrice: 30 }] } })]]);
    const res = await app.request("/api/search?q=toaster&sources=bestbuy");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.products[0]).toMatchObject({ id: "bestbuy:1234567", price: { amount: 30 } });
  });

  it("validates link and image requests", async () => {
    const post = (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/api/resolve", { urls: [] })).status).toBe(400);
    expect((await post("/api/resolve", { urls: Array(11).fill("https://a.com/x") })).status).toBe(400);
    expect((await post("/api/search/image", {})).status).toBe(400);
  });

  it("photo search still returns eBay visual matches without an Anthropic key", async () => {
    setEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "s" });
    mockFetch([
      [/oauth2\/token/, () => ({ json: { access_token: "t", expires_in: 7200 } })],
      [/search_by_image/, () => ({ json: { itemSummaries: [{ legacyItemId: "999999999", title: "Look-alike lamp", itemWebUrl: "https://www.ebay.com/itm/999999999" }] } })],
    ]);
    const res = await app.request("/api/search/image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: Buffer.from("fake").toString("base64"), mime_type: "image/jpeg" }),
    });
    const body = await res.json();
    expect(body.products[0].title).toBe("Look-alike lamp");
    expect(body.providers.some((r: any) => r.status === "skipped" && /ANTHROPIC_API_KEY/.test(r.error))).toBe(true);
  });
});
