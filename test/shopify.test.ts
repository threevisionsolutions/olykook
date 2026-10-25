import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromMinor, mapShopifyProduct, preferCurrency, shopify } from "../src/providers/shopify.js";
import { groupSameProduct } from "../src/services/search.js";
import { clearEnv, mockFetch, setEnv } from "./helpers.js";

beforeEach(() => {
  clearEnv();
  setEnv({ SHOPIFY_CATALOG_CLIENT_ID: undefined, SHOPIFY_CATALOG_CLIENT_SECRET: undefined, SHOPIFY_CATALOG_DISABLED: undefined });
});
afterEach(() => vi.unstubAllGlobals());

/** Shape copied from a live search_catalog response (Oct 2026), trimmed. */
const skullcandy = {
  id: "gid://shopify/p/3EMUIdNrQxFBRMpvM8jfBN",
  title: "Crusher® ANC 2",
  handle: "crusher-anc-2",
  description: { html: "<p>Sensory bass with <b>ANC</b>.</p>" },
  rating: { value: 4.4, scale_min: 1, scale_max: 5, count: 16951 },
  media: [{ type: "image", url: "https://cdn.shopify.com/crusher.png" }],
  metadata: {
    top_features: ["Adjustable Crusher Sensory Bass", "Active Noise Cancellation"],
    tech_specs: ["Driver Size: 40 mm", "Battery Life: Up to 50 hours", "not a spec line"],
  },
  price_range: { min: { amount: 23999, currency: "USD" }, max: { amount: 23999, currency: "USD" } },
  variants: [{
    id: "gid://shopify/ProductVariant/43456297173049",
    url: "https://www.skullcandy.com/products/crusher-anc-2?variant=43456297173049",
    price: { amount: 23999, currency: "USD" },
    list_price: { amount: 29999, currency: "USD" },
    availability: { available: true },
    condition: ["new"],
    seller: { name: "Skullcandy", url: "https://www.skullcandy.com" },
  }],
};

const rpc = (structuredContent: unknown) => ({ json: { jsonrpc: "2.0", id: 1, result: { structuredContent } } });

describe("Shopify Global Catalog", () => {
  it("is on by default, with no key", () => {
    expect(shopify.isConfigured()).toBe(true);
    setEnv({ SHOPIFY_CATALOG_DISABLED: "true" });
    expect(shopify.isConfigured()).toBe(false);
  });

  it("maps catalog products into the shared Product shape", () => {
    expect(mapShopifyProduct(skullcandy)).toMatchObject({
      id: "shopify:gid://shopify/p/3EMUIdNrQxFBRMpvM8jfBN",
      source: "shopify",
      store: "Skullcandy",
      title: "Crusher® ANC 2",
      url: "https://www.skullcandy.com/products/crusher-anc-2?variant=43456297173049",
      price: { amount: 239.99, currency: "USD" },
      originalPrice: { amount: 299.99, currency: "USD" },
      rating: 4.4,
      reviewCount: 16951,
      availability: "In stock",
      condition: "new",
      description: "Sensory bass with ANC .",
      specs: { "Driver Size": "40 mm", "Battery Life": "Up to 50 hours" },
      identifiers: { upid: "gid://shopify/p/3EMUIdNrQxFBRMpvM8jfBN" },
      via: "api",
    });
  });

  it("converts minor units correctly, including currencies without cents", () => {
    expect(fromMinor({ amount: 23999, currency: "USD" })).toEqual({ amount: 239.99, currency: "USD" });
    expect(fromMinor({ amount: 4500, currency: "JPY" })).toEqual({ amount: 4500, currency: "JPY" });
  });

  it("sends an anonymous search with the agent profile, price filter in cents and US shipping", async () => {
    const log = mockFetch([[/catalog\.shopify\.com/, () => rpc({ products: [skullcandy] })]]);
    const results = await shopify.search({ query: "noise cancelling headphones", maxPrice: 300, limit: 5 });
    expect(log).toHaveLength(1);
    expect(log[0].headers.authorization).toBeUndefined();
    const body = JSON.parse(log[0].body!);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("search_catalog");
    expect(body.params.arguments.meta["ucp-agent"].profile).toMatch(/^https:\/\//);
    expect(body.params.arguments.catalog).toMatchObject({
      query: "noise cancelling headphones",
      filters: { ships_to: { country: "US" }, price: { max: 30000 } },
      pagination: { limit: 10 },
    });
    expect(results[0].title).toBe("Crusher® ANC 2");
  });

  it("uses a bearer token when a free Catalogs API key is configured", async () => {
    setEnv({ SHOPIFY_CATALOG_CLIENT_ID: "cid", SHOPIFY_CATALOG_CLIENT_SECRET: "sec" });
    const log = mockFetch([
      [/api\.shopify\.com\/auth\/access_token/, () => ({ json: { access_token: "jwt-token", expires_in: 3600 } })],
      [/catalog\.shopify\.com/, () => rpc({ products: [] })],
    ]);
    await shopify.search({ query: "x" });
    expect(JSON.parse(log[0].body!)).toEqual({ client_id: "cid", client_secret: "sec", grant_type: "client_credentials" });
    expect(log[1].headers.authorization).toBe("Bearer jwt-token");
  });

  it("does photo search by sending the image itself", async () => {
    const log = mockFetch([[/catalog\.shopify\.com/, () => rpc({ products: [skullcandy] })]]);
    const results = await shopify.searchByImage!({ base64: "aW1n", mimeType: "image/png" }, 6);
    const catalog = JSON.parse(log[0].body!).params.arguments.catalog;
    expect(catalog.like).toEqual([{ image: { content_type: "image/png", data: "aW1n" } }]);
    expect(catalog.query).toBeUndefined();
    expect(results).toHaveLength(1);
  });

  it("looks up pasted store links and picks the offer from that store", async () => {
    const twoSellers = {
      ...skullcandy,
      variants: [
        { ...skullcandy.variants[0], seller: { name: "Focus Camera", url: "https://www.focuscamera.com" }, url: "https://www.focuscamera.com/products/x" },
        skullcandy.variants[0],
      ],
    };
    const log = mockFetch([[/catalog\.shopify\.com/, () => rpc({ products: [twoSellers] })]]);
    const p = await shopify.getByUrl!(new URL("https://www.skullcandy.com/products/crusher-anc-2?utm_source=x"));
    expect(JSON.parse(log[0].body!).params.arguments.catalog.ids).toEqual(["https://www.skullcandy.com/products/crusher-anc-2"]);
    expect(p?.store).toBe("Skullcandy");
  });

  it("returns null for links the catalog doesn't know, so the page reader takes over", async () => {
    mockFetch([[/catalog\.shopify\.com/, () => rpc({ products: [], messages: [{ code: "not_found" }] })]]);
    expect(await shopify.getByUrl!(new URL("https://www.example.com/products/nothing"))).toBeNull();
  });

  it("surfaces JSON-RPC errors such as rate limits", async () => {
    mockFetch([[/catalog\.shopify\.com/, () => ({ json: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Rate limit exceeded", data: "retry after 30 seconds" } } })]]);
    await expect(shopify.search({ query: "x" })).rejects.toThrow(/Rate limit exceeded/);
  });

  it("puts results in the shopper's currency first", () => {
    const usd = mapShopifyProduct(skullcandy);
    const dkk = { ...usd, id: "shopify:dkk", price: { amount: 580, currency: "DKK" } };
    expect(preferCurrency([dkk, usd], "USD", 5).map((p) => p.id)).toEqual([usd.id, "shopify:dkk"]);
  });

  it("groups the same product sold by different Shopify stores", () => {
    const a = mapShopifyProduct(skullcandy);
    const b = { ...a, id: "shopify:other", store: "Focus Camera", price: { amount: 229, currency: "USD" } };
    const groups = groupSameProduct([a, b]);
    expect(groups).toHaveLength(1);
    expect(groups[0].offers[0].store).toBe("Focus Camera");
  });
});
