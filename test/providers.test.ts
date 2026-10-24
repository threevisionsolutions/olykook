import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aliexpress, aliexpressIdFromUrl, signAliExpress } from "../src/providers/aliexpress.js";
import { amazon, asinFromUrl } from "../src/providers/amazon.js";
import { bestbuy, bestBuySkuFromUrl } from "../src/providers/bestbuy.js";
import { ebay, ebayItemIdFromUrl } from "../src/providers/ebay.js";
import { etsy } from "../src/providers/etsy.js";
import { googleShopping } from "../src/providers/serpapi.js";
import { walmart, walmartHeaders, walmartIdFromUrl } from "../src/providers/walmart.js";
import { clearEnv, mockFetch, setEnv } from "./helpers.js";

beforeEach(clearEnv);
afterEach(() => vi.unstubAllGlobals());

describe("eBay", () => {
  beforeEach(() => setEnv({ EBAY_CLIENT_ID: "id", EBAY_CLIENT_SECRET: "secret", EBAY_CAMPAIGN_ID: "5338" }));

  it("gets an app token, then searches with marketplace + affiliate headers", async () => {
    const log = mockFetch([
      [/oauth2\/token/, () => ({ json: { access_token: "tok", expires_in: 7200 } })],
      [/item_summary\/search\?/, () => ({
        json: {
          itemSummaries: [{
            itemId: "v1|123456789012|0", legacyItemId: "123456789012", title: "Sony WH-1000XM5",
            price: { value: "248.00", currency: "USD" }, image: { imageUrl: "https://i.ebayimg.com/a.jpg" },
            itemWebUrl: "https://www.ebay.com/itm/123456789012", itemAffiliateWebUrl: "https://www.ebay.com/itm/123456789012?mkcid=1",
            condition: "New", seller: { username: "bestseller", feedbackPercentage: "99.5" },
            shippingOptions: [{ shippingCost: { value: "0.00", currency: "USD" } }],
          }],
        },
      })],
    ]);

    const results = await ebay.search({ query: "sony headphones", limit: 5, maxPrice: 300, sort: "price_asc" });

    expect(log[0].headers.authorization).toBe(`Basic ${Buffer.from("id:secret").toString("base64")}`);
    expect(log[0].body).toContain("scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope");
    const search = new URL(log[1].url);
    expect(search.searchParams.get("q")).toBe("sony headphones");
    expect(search.searchParams.get("filter")).toBe("price:[..300],priceCurrency:USD");
    expect(search.searchParams.get("sort")).toBe("price");
    expect(log[1].headers["x-ebay-c-marketplace-id"]).toBe("EBAY_US");
    expect(log[1].headers["x-ebay-c-enduserctx"]).toBe("affiliateCampaignId=5338");

    expect(results[0]).toMatchObject({
      id: "ebay:123456789012", store: "eBay", title: "Sony WH-1000XM5",
      price: { amount: 248, currency: "USD" }, url: "https://www.ebay.com/itm/123456789012?mkcid=1",
      seller: "bestseller (99.5% positive)", shipping: "Free shipping", via: "api",
    });
  });

  it("sends the image as base64 for image search", async () => {
    const log = mockFetch([
      [/oauth2\/token/, () => ({ json: { access_token: "tok", expires_in: 7200 } })],
      [/search_by_image/, () => ({ json: { itemSummaries: [] } })],
    ]);
    await ebay.searchByImage!({ base64: "QUJD", mimeType: "image/jpeg" }, 7);
    const req = log.find((r) => r.url.includes("search_by_image"))!;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body!)).toEqual({ image: "QUJD" });
    expect(req.url).toContain("limit=7");
  });

  it("reads item ids from eBay links", () => {
    expect(ebayItemIdFromUrl(new URL("https://www.ebay.com/itm/Sony-Headphones/123456789012?hash=x"))).toBe("123456789012");
    expect(ebayItemIdFromUrl(new URL("https://www.ebay.co.uk/itm/223344556677"))).toBe("223344556677");
  });
});

describe("Amazon Creators API", () => {
  beforeEach(() => setEnv({ AMAZON_CREDENTIAL_ID: "cid", AMAZON_CREDENTIAL_SECRET: "csec", AMAZON_PARTNER_TAG: "shop-20" }));

  it("uses Login with Amazon for v3.1 credentials and calls searchItems", async () => {
    const log = mockFetch([
      [/api\.amazon\.com\/auth\/o2\/token/, () => ({ json: { access_token: "lwa", expires_in: 3600 } })],
      [/creatorsapi\.amazon\/catalog\/v1\/searchItems/, () => ({
        json: {
          searchResult: {
            items: [{
              asin: "B0BX2L8PBT", detailPageURL: "https://www.amazon.com/dp/B0BX2L8PBT?tag=shop-20",
              itemInfo: {
                title: { displayValue: "Apple AirPods Pro (2nd Gen)" },
                byLineInfo: { brand: { displayValue: "Apple" } },
                features: { displayValues: ["Active Noise Cancellation", "USB-C"] },
                externalIds: { upcs: { displayValues: ["194253939207"] } },
              },
              images: { primary: { large: { url: "https://m.media-amazon.com/images/I/a.jpg" } } },
              customerReviews: { count: 51234, starRating: { value: 4.7 } },
              offersV2: { listings: [{
                isBuyBoxWinner: true,
                price: { money: { amount: 189.99, currency: "USD" }, savingBasis: { money: { amount: 249, currency: "USD" } } },
                availability: { message: "In Stock" }, merchantInfo: { name: "Amazon.com" },
              }] },
            }],
          },
        },
      })],
    ]);

    const [item] = await amazon.search({ query: "airpods", minPrice: 100 });
    expect(JSON.parse(log[0].body!)).toEqual({ grant_type: "client_credentials", client_id: "cid", client_secret: "csec", scope: "creatorsapi::default" });
    expect(log[1].headers.authorization).toBe("Bearer lwa");
    expect(log[1].headers["x-marketplace"]).toBe("www.amazon.com");
    const body = JSON.parse(log[1].body!);
    expect(body).toMatchObject({ keywords: "airpods", partnerTag: "shop-20", itemCount: 10, sortBy: "Relevance", minPrice: 10000 });
    expect(body.resources).toContain("offersV2.listings.price");

    expect(item).toMatchObject({
      id: "amazon:B0BX2L8PBT", title: "Apple AirPods Pro (2nd Gen)", brand: "Apple",
      price: { amount: 189.99, currency: "USD" }, originalPrice: { amount: 249, currency: "USD" },
      rating: 4.7, reviewCount: 51234, seller: "Amazon.com", identifiers: { asin: "B0BX2L8PBT", upc: "194253939207" },
    });
  });

  it("uses Cognito + 'Version' header for v2.x credentials", async () => {
    setEnv({ AMAZON_CREDENTIAL_VERSION: "2.1" });
    // A fresh module instance so the token cache from the previous test isn't reused.
    vi.resetModules();
    const { amazon: fresh } = await import("../src/providers/amazon.js");
    const log = mockFetch([
      [/amazoncognito\.com\/oauth2\/token/, () => ({ json: { access_token: "cog", expires_in: 3600 } })],
      [/getItems/, () => ({ json: { itemsResult: { items: [{ asin: "B000000001", itemInfo: { title: { displayValue: "Thing" } } }] } } })],
    ]);
    const p = await fresh.getByUrl!(new URL("https://www.amazon.com/Some-Thing/dp/B000000001/ref=sr_1_1"));
    expect(log[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(log[0].body).toContain("scope=creatorsapi%2Fdefault");
    expect(log[1].headers.authorization).toBe("Bearer cog, Version 2.1");
    expect(JSON.parse(log[1].body!).itemIds).toEqual(["B000000001"]);
    expect(p?.title).toBe("Thing");
  });

  it("falls back to SerpApi when only SERPAPI_API_KEY is set", async () => {
    clearEnv();
    setEnv({ SERPAPI_API_KEY: "serp" });
    const log = mockFetch([
      [/serpapi\.com/, () => ({ json: { organic_results: [
        { asin: "B0C1", title: "Cheap buds", extracted_price: 19.99, price: "$19.99", rating: 4.2, reviews: 812, thumbnail: "https://x/y.jpg", link_clean: "https://www.amazon.com/dp/B0C1" },
        { asin: "B0C2", title: "Pricey buds", extracted_price: 399, price: "$399.00" },
      ] } })],
    ]);
    expect(amazon.isConfigured()).toBe(true);
    const results = await amazon.search({ query: "earbuds", maxPrice: 100 });
    expect(new URL(log[0].url).searchParams.get("engine")).toBe("amazon");
    expect(results.map((r) => r.sourceId)).toEqual(["B0C1"]);
    expect(results[0]).toMatchObject({ price: { amount: 19.99, currency: "USD" }, via: "serpapi" });
  });

  it("reads ASINs from every common Amazon link format", () => {
    expect(asinFromUrl(new URL("https://www.amazon.com/Apple-AirPods/dp/B0BX2L8PBT/ref=sr_1_1?th=1"))).toBe("B0BX2L8PBT");
    expect(asinFromUrl(new URL("https://www.amazon.co.uk/gp/product/B08N5WRWNW"))).toBe("B08N5WRWNW");
    expect(asinFromUrl(new URL("https://www.amazon.com/gp/aw/d/B08N5WRWNW"))).toBe("B08N5WRWNW");
    expect(asinFromUrl(new URL("https://www.amazon.com/s?k=airpods"))).toBeUndefined();
  });
});

describe("AliExpress", () => {
  it("signs requests the way the AliExpress gateway expects (MD5, secret-wrapped, sorted keys)", () => {
    const sig = signAliExpress("testsecret", {
      app_key: "12345", method: "aliexpress.affiliate.product.query", format: "json", v: "2.0",
      sign_method: "md5", timestamp: "1700000000000", keywords: "phone case", page_size: "10",
    });
    expect(sig).toBe("25DAD22086FFA864F661A615693AEB1F");
  });

  it("searches and maps affiliate products, filtering by price on our side", async () => {
    setEnv({ ALIEXPRESS_APP_KEY: "k", ALIEXPRESS_APP_SECRET: "s", ALIEXPRESS_TRACKING_ID: "trk" });
    const log = mockFetch([
      [/api-sg\.aliexpress\.com\/sync/, () => ({ json: { aliexpress_affiliate_product_query_response: { resp_result: { resp_code: 200, resp_msg: "ok", result: {
        current_record_count: 2,
        products: { product: [
          { product_id: 1005001, product_title: "Magnetic iPhone case", target_sale_price: "4.99", target_sale_price_currency: "USD",
            target_original_price: "9.98", target_original_price_currency: "USD", product_main_image_url: "https://ae01.alicdn.com/a.jpg",
            product_small_image_urls: { string: ["https://ae01.alicdn.com/b.jpg"] }, promotion_link: "https://s.click.aliexpress.com/e/_abc",
            evaluate_rate: "96.8%", lastest_volume: 5120, first_level_category_name: "Phones" },
          { product_id: 1005002, product_title: "Luxury case", target_sale_price: "59.00", target_sale_price_currency: "USD" },
        ] },
      } } } } })],
    ]);

    const results = await aliexpress.search({ query: "iphone case", maxPrice: 20 });
    const url = new URL(log[0].url);
    expect(url.searchParams.get("method")).toBe("aliexpress.affiliate.product.query");
    expect(url.searchParams.get("sign")).toMatch(/^[0-9A-F]{32}$/);
    const form = new URLSearchParams(log[0].body);
    expect(form.get("keywords")).toBe("iphone case");
    expect(form.get("tracking_id")).toBe("trk");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "aliexpress:1005001", price: { amount: 4.99, currency: "USD" }, originalPrice: { amount: 9.98, currency: "USD" },
      url: "https://s.click.aliexpress.com/e/_abc", salesVolume: 5120,
      images: ["https://ae01.alicdn.com/a.jpg", "https://ae01.alicdn.com/b.jpg"],
    });
    expect(results[0].specs?.["Positive feedback"]).toBe("96.8%");
  });

  it("turns gateway errors into readable messages", async () => {
    setEnv({ ALIEXPRESS_APP_KEY: "k", ALIEXPRESS_APP_SECRET: "s" });
    mockFetch([[/aliexpress/, () => ({ json: { error_response: { code: "IncompleteSignature", msg: "The request signature does not conform" } } })]]);
    await expect(aliexpress.search({ query: "x" })).rejects.toThrow(/IncompleteSignature/);
  });

  it("reads product ids from links", () => {
    expect(aliexpressIdFromUrl(new URL("https://www.aliexpress.com/item/1005006123456789.html?spm=a2g0o"))).toBe("1005006123456789");
  });
});

describe("Walmart", () => {
  it("signs consumerId/timestamp/keyVersion with RSA-SHA256", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    setEnv({ WALMART_CONSUMER_ID: "consumer-123", WALMART_KEY_VERSION: "2", WALMART_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
    const h = walmartHeaders(1700000000000);
    expect(h["WM_CONSUMER.INTIMESTAMP"]).toBe("1700000000000");
    const ok = createVerify("RSA-SHA256").update("consumer-123\n1700000000000\n2\n").verify(publicKey, h["WM_SEC.AUTH_SIGNATURE"], "base64");
    expect(ok).toBe(true);
  });

  it("searches the affiliate API and maps items", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    setEnv({ WALMART_CONSUMER_ID: "c", WALMART_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), WALMART_PUBLISHER_ID: "pub1" });
    const log = mockFetch([[/affil\/product\/v2\/search/, () => ({ json: { items: [{
      itemId: 5129928, name: "Instant Pot Duo 7-in-1", salePrice: 79, msrp: 99.95, upc: "853084004019",
      largeImage: "https://i5.walmartimages.com/a.jpeg", productTrackingUrl: "https://goto.walmart.com/c/1/2?u=x",
      customerRating: "4.6", numReviews: 24711, brandName: "Instant Pot", stock: "Available",
    }] } })]]);
    const [p] = await walmart.search({ query: "instant pot", sort: "price_asc" });
    const url = new URL(log[0].url);
    expect(url.searchParams.get("publisherId")).toBe("pub1");
    expect(url.searchParams.get("sort")).toBe("price");
    expect(log[0].headers["wm_consumer.id"]).toBe("c");
    expect(p).toMatchObject({ id: "walmart:5129928", price: { amount: 79 }, originalPrice: { amount: 99.95 }, rating: 4.6, identifiers: { upc: "853084004019" } });
  });

  it("reads item ids from links", () => {
    expect(walmartIdFromUrl(new URL("https://www.walmart.com/ip/Instant-Pot-Duo/5129928?athbdg=L1200"))).toBe("5129928");
  });
});

describe("Best Buy", () => {
  it("builds the (search=…&salePrice<=…) query and maps products", async () => {
    setEnv({ BESTBUY_API_KEY: "bb" });
    const log = mockFetch([[/api\.bestbuy\.com/, () => ({ json: { products: [{
      sku: 6505727, name: "Sony WH-1000XM5", salePrice: 329.99, regularPrice: 399.99, url: "https://www.bestbuy.com/site/6505727.p",
      image: "https://pisces.bbystatic.com/a.jpg", customerReviewAverage: 4.7, customerReviewCount: 3021, manufacturer: "Sony",
      modelNumber: "WH1000XM5/B", upc: "027242923232", onlineAvailability: true, freeShipping: true,
      features: [{ feature: "Industry-leading noise canceling" }], details: [{ name: "Battery Life", value: "30 hours" }],
    }] } })]]);
    const [p] = await bestbuy.search({ query: "sony wh-1000xm5!", maxPrice: 350 });
    expect(decodeURIComponent(log[0].url)).toContain("/v1/products(search=sony&search=wh-1000xm5&salePrice<=350)?");
    expect(p).toMatchObject({ id: "bestbuy:6505727", price: { amount: 329.99 }, originalPrice: { amount: 399.99 }, specs: { "Battery Life": "30 hours" }, availability: "In stock online" });
  });

  it("reads SKUs from links", () => {
    expect(bestBuySkuFromUrl(new URL("https://www.bestbuy.com/site/sony-wh1000xm5/6505727.p?skuId=6505727"))).toBe("6505727");
    expect(bestBuySkuFromUrl(new URL("https://www.bestbuy.com/site/sony-wh1000xm5/6505727.p"))).toBe("6505727");
  });
});

describe("Etsy", () => {
  it("searches, then adds images with one batch call", async () => {
    setEnv({ ETSY_API_KEY: "key", ETSY_SHARED_SECRET: "sec" });
    const log = mockFetch([
      [/listings\/active/, () => ({ json: { results: [{ listing_id: 111, title: "Handmade &amp; leather wallet", price: { amount: 4500, divisor: 100, currency_code: "USD" }, url: "https://www.etsy.com/listing/111/wallet" }] } })],
      [/listings\/batch/, () => ({ json: { results: [{ listing_id: 111, images: [{ url_570xN: "https://i.etsystatic.com/570.jpg", url_fullxfull: "https://i.etsystatic.com/full.jpg" }], shop: { shop_name: "LeatherCo" } }] } })],
    ]);
    const [p] = await etsy.search({ query: "leather wallet" });
    expect(log[0].headers["x-api-key"]).toBe("key:sec");
    expect(log[1].url).toContain("listing_ids=111");
    expect(p).toMatchObject({ title: "Handmade & leather wallet", price: { amount: 45, currency: "USD" }, imageUrl: "https://i.etsystatic.com/full.jpg", seller: "LeatherCo" });
  });
});

describe("Google Shopping (SerpApi)", () => {
  it("maps shopping results from many stores", async () => {
    setEnv({ SERPAPI_API_KEY: "serp" });
    mockFetch([[/serpapi/, () => ({ json: { shopping_results: [
      { position: 1, product_id: "987", title: "Dyson V8", source: "Target", extracted_price: 349.99, price: "$349.99", extracted_old_price: 469.99, old_price: "$469.99", rating: 4.6, reviews: 12000, product_link: "https://www.google.com/shopping/product/987", thumbnail: "https://t/1.jpg", delivery: "Free delivery" },
    ] } })]]);
    const [p] = await googleShopping.search({ query: "dyson v8" });
    expect(p).toMatchObject({ store: "Target", price: { amount: 349.99 }, originalPrice: { amount: 469.99 }, shipping: "Free delivery", via: "serpapi" });
  });

  it("skips Google Lens when the image has no public URL", async () => {
    setEnv({ SERPAPI_API_KEY: "serp" });
    const log = mockFetch([]);
    expect(await googleShopping.searchByImage!({ base64: "x", mimeType: "image/png" }, 5)).toEqual([]);
    expect(log).toHaveLength(0);
  });
});
