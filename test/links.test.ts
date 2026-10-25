import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedPageError, extractProduct, NotAProductError } from "../src/scrape/extract.js";
import { assertPublicUrl, isPrivateAddress } from "../src/scrape/fetchPage.js";
import { normalizeUrl, resolveUrl } from "../src/services/resolveUrl.js";
import type { Product, Provider } from "../src/types.js";
import {
  ALIEXPRESS_CAPTCHA, AMAZON_CONTINUE_WALL, AMAZON_LIVE_PAGE, AMAZON_PAGE, AMAZON_UNAVAILABLE_PAGE, CAPTCHA_PAGE,
  CATEGORY_PAGE, OG_ONLY_PAGE, SHOPIFY_META_ONLY_PAGE, SHOPIFY_PAGE, WALMART_BLOCKED,
} from "./fixtures.js";
import { clearEnv } from "./helpers.js";

beforeEach(clearEnv);
afterEach(() => vi.unstubAllGlobals());

describe("reading product pages", () => {
  it("reads schema.org JSON-LD, including @graph and ProductGroup variants", () => {
    const p = extractProduct(SHOPIFY_PAGE, new URL("https://www.allbirds.com/products/mens-tree-runners?variant=1"));
    expect(p).toMatchObject({
      source: "web",
      store: "allbirds.com",
      title: "Men's Tree Runners",
      brand: "Allbirds",
      price: { amount: 98, currency: "USD" },
      rating: 4.5,
      reviewCount: 2310,
      availability: "In Stock",
      imageUrl: "https://www.allbirds.com/img/tr-1.jpg",
      url: "https://www.allbirds.com/products/mens-tree-runners",
      identifiers: { gtin: "0194568123456", sku: "TR-M-9" },
      via: "page",
    });
    expect(p.description).toContain("eucalyptus");
  });

  it("reads Amazon product pages from their page elements", () => {
    const p = extractProduct(AMAZON_PAGE, new URL("https://www.amazon.com/dp/B07QXV6N1B"));
    expect(p).toMatchObject({
      source: "amazon",
      store: "Amazon",
      title: "Anker Power Bank, 10,000mAh Portable Charger",
      brand: "Anker",
      price: { amount: 21.99, currency: "USD" },
      originalPrice: { amount: 29.99, currency: "USD" },
      rating: 4.6,
      reviewCount: 48512,
      availability: "In Stock",
      imageUrl: "https://m.media-amazon.com/images/I/big.jpg",
      specs: { "Battery Capacity": "10000 Milliamp Hours" },
    });
    expect(p.features).toEqual(["Charges an iPhone 15 about 2 times", "USB-C in and out"]);
  });

  it("falls back to OpenGraph tags and handles European price formats", () => {
    const p = extractProduct(OG_ONLY_PAGE, new URL("https://shop.example/lamp"));
    expect(p).toMatchObject({ title: "Vintage Desk Lamp", price: { amount: 1299, currency: "EUR" }, imageUrl: "https://shop.example/lamp.jpg" });
  });

  it("recognises bot-check pages instead of returning junk", () => {
    expect(() => extractProduct(CAPTCHA_PAGE, new URL("https://www.amazon.com/dp/B07QXV6N1B"))).toThrow(BlockedPageError);
  });
});

describe("live-page cases", () => {
  it("Amazon: finds the price in the newer layout, ignores script text, and keeps a clean /dp/ link", () => {
    const p = extractProduct(AMAZON_LIVE_PAGE, new URL("https://www.amazon.com/Apple-AirPods/dp/B0CHWRXH8B"));
    expect(p).toMatchObject({
      id: "amazon:B0CHWRXH8B",
      sourceId: "B0CHWRXH8B",
      url: "https://www.amazon.com/dp/B0CHWRXH8B",
      price: { amount: 263.86, currency: "USD" },
      availability: "In Stock",
      identifiers: { asin: "B0CHWRXH8B" },
    });
  });

  it("Amazon: reports items with no seller as unavailable", () => {
    const p = extractProduct(AMAZON_UNAVAILABLE_PAGE, new URL("https://www.amazon.com/dp/B07XJ8C8F5"));
    expect(p.price).toBeUndefined();
    expect(p.availability).toBe("Currently unavailable");
  });

  it("recognises the bot walls Amazon, AliExpress and Walmart show to servers", () => {
    expect(() => extractProduct(AMAZON_CONTINUE_WALL, new URL("https://www.amazon.com/dp/B0CHWRXH8B"))).toThrow(BlockedPageError);
    expect(() => extractProduct(ALIEXPRESS_CAPTCHA, new URL("https://www.aliexpress.com/item/1.html"))).toThrow(BlockedPageError);
    expect(() => extractProduct(WALMART_BLOCKED, new URL("https://www.walmart.com/blocked?url=abc"))).toThrow(BlockedPageError);
  });

  it("reads Shopify's built-in product data when there's no JSON-LD (cheapest variant, or the one in the link)", () => {
    const cheapest = extractProduct(SHOPIFY_META_ONLY_PAGE, new URL("https://www.brooklinen.com/products/classic-core-sheet-set"));
    expect(cheapest).toMatchObject({ title: "Classic Percale Core Sheet Set", brand: "Brooklinen", price: { amount: 159, currency: "USD" } });
    const king = extractProduct(SHOPIFY_META_ONLY_PAGE, new URL("https://www.brooklinen.com/products/classic-core-sheet-set?variant=111"));
    expect(king.price?.amount).toBe(189);
  });

  it("decodes HTML entities that stores leave in their product data", () => {
    const html = `<script type="application/ld+json">{"@type":"Product","name":"Arrival 5&quot; Shorts &amp; Tee","offers":{"price":"26","priceCurrency":"USD"}}</script>`;
    expect(extractProduct(html, new URL("https://www.gymshark.com/products/x")).title).toBe('Arrival 5" Shorts & Tee');
  });

  it("refuses category pages instead of calling them products", () => {
    expect(() => extractProduct(CATEGORY_PAGE, new URL("https://www.ikea.com/us/en/cat/products-products/"))).toThrow(NotAProductError);
  });
});

describe("link safety", () => {
  it("flags private and internal addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it("refuses to fetch localhost, cloud metadata and non-http links", async () => {
    await expect(assertPublicUrl(new URL("http://localhost:3000/admin"))).rejects.toThrow();
    await expect(assertPublicUrl(new URL("http://169.254.169.254/latest/meta-data"))).rejects.toThrow();
    await expect(assertPublicUrl(new URL("file:///etc/passwd"))).rejects.toThrow();
  });
});

describe("resolving pasted links", () => {
  const fakeProduct: Product = { id: "ebay:1", source: "ebay", sourceId: "1", store: "eBay", title: "From API", url: "https://ebay.com/itm/1", via: "api" };
  const fakeEbay = (impl: () => Promise<Product | null>): Provider => ({
    id: "ebay", name: "eBay", setup: "", isConfigured: () => true, search: async () => [],
    matchesUrl: (u) => u.hostname.endsWith("ebay.com"), getByUrl: impl,
  });

  it("strips tracking parameters", () => {
    expect(normalizeUrl("https://www.amazon.com/dp/B07QXV6N1B?ref_=abc&tag=x-20&th=1&utm_source=y&color=red").href).toBe(
      "https://www.amazon.com/dp/B07QXV6N1B?color=red",
    );
    expect(normalizeUrl("www.etsy.com/listing/1").href).toBe("https://www.etsy.com/listing/1");
  });

  it("uses the store API when one matches the link", async () => {
    const fetcher = vi.fn();
    const r = await resolveUrl("https://www.ebay.com/itm/111111111111", { providerList: [fakeEbay(async () => fakeProduct)], fetcher });
    expect(r.product?.title).toBe("From API");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to reading the page when the store API fails", async () => {
    const fetcher = vi.fn(async (u: string) => ({ finalUrl: new URL(u), html: SHOPIFY_PAGE }));
    const r = await resolveUrl("https://www.ebay.com/itm/222222222222", {
      providerList: [fakeEbay(async () => { throw new Error("rate limited"); })],
      fetcher,
    });
    expect(r.product?.via).toBe("page");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("expands short links before matching a store", async () => {
    const fetcher = vi.fn(async () => ({ finalUrl: new URL("https://www.ebay.com/itm/333333333333"), html: "<html></html>" }));
    const getByUrl = vi.fn(async () => fakeProduct);
    const r = await resolveUrl("https://ebay.us/abc", { providerList: [fakeEbay(getByUrl)], fetcher });
    expect(getByUrl).toHaveBeenCalledWith(new URL("https://www.ebay.com/itm/333333333333"));
    expect(r.product).toBe(fakeProduct);
  });

  it("returns a readable error for bot-check pages", async () => {
    const fetcher = vi.fn(async (u: string) => ({ finalUrl: new URL(u), html: CAPTCHA_PAGE }));
    const r = await resolveUrl("https://shop.example/blocked-item", { providerList: [], fetcher });
    expect(r.error).toMatch(/bot check/);
  });

  it("rejects things that aren't links", async () => {
    expect((await resolveUrl("not a url at all", { providerList: [] })).error).toBeTruthy();
  });
});
