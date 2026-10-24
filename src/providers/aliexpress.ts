/**
 * AliExpress Affiliate API (free; needs an AliExpress Portals affiliate account
 * plus an app on the AliExpress Open Platform).
 * Docs: https://openservice.aliexpress.com  (search "aliexpress.affiliate.product.query")
 *
 * Every call is a signed POST to https://api-sg.aliexpress.com/sync:
 * sign = MD5(secret + sorted "keyvalue" pairs + secret), upper-case hex.
 *
 * Note: Alibaba.com (the wholesale/B2B site) has no public product-search API.
 * AliExpress is Alibaba Group's consumer marketplace and covers most of the same
 * suppliers. Pasted alibaba.com links are still read from the page.
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { compact, fetchJson, parsePrice, toNumber } from "../lib/http.js";
import type { Money, Product, Provider } from "../types.js";
import { inPriceRange } from "./serpapi.js";

const GATEWAY = "https://api-sg.aliexpress.com/sync";

export function signAliExpress(secret: string, params: Record<string, string>): string {
  const joined = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join("");
  return createHash("md5").update(`${secret}${joined}${secret}`, "utf8").digest("hex").toUpperCase();
}

async function call(method: string, appParams: Record<string, string | number | undefined>): Promise<any> {
  const sys: Record<string, string> = {
    app_key: config.aliexpress.appKey,
    method,
    format: "json",
    v: "2.0",
    sign_method: "md5",
    timestamp: String(Date.now()),
  };
  const app: Record<string, string> = {};
  for (const [k, v] of Object.entries(appParams)) if (v !== undefined && v !== "") app[k] = String(v);
  sys.sign = signAliExpress(config.aliexpress.appSecret, { ...sys, ...app });

  const data = await fetchJson(`${GATEWAY}?${new URLSearchParams(sys)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body: new URLSearchParams(app),
  });

  if (data.error_response) {
    const e = data.error_response;
    throw new Error(`AliExpress ${e.code ?? ""}: ${e.sub_msg ?? e.msg ?? "request failed"}`);
  }
  const responseKey = `${method.replace(/\./g, "_")}_response`;
  const resp = data[responseKey]?.resp_result;
  if (!resp) throw new Error("AliExpress: unexpected response shape");
  if (Number(resp.resp_code) !== 200) throw new Error(`AliExpress ${resp.resp_code}: ${resp.resp_msg}`);
  return resp.result;
}

const money = (amount: unknown, currency: unknown): Money | undefined => {
  const n = parsePrice(amount);
  return n !== undefined ? { amount: n, currency: String(currency || config.currency) } : undefined;
};

export function mapAliExpressProduct(p: any): Product {
  const images = [p.product_main_image_url, ...(p.product_small_image_urls?.string ?? p.product_small_image_urls ?? [])].filter(
    (x) => typeof x === "string",
  );
  const sale = money(p.target_sale_price ?? p.sale_price, p.target_sale_price_currency ?? p.sale_price_currency);
  const original = money(p.target_original_price ?? p.original_price, p.target_original_price_currency ?? p.original_price_currency);
  const positive = parsePrice(p.evaluate_rate); // e.g. "96.8%" positive feedback

  return compact({
    id: `aliexpress:${p.product_id}`,
    source: "aliexpress",
    sourceId: String(p.product_id),
    store: "AliExpress",
    title: p.product_title,
    url: p.promotion_link ?? p.product_detail_url,
    imageUrl: images[0],
    images,
    price: sale,
    originalPrice: original && sale && original.amount > sale.amount ? original : undefined,
    seller: p.shop_name ?? (p.shop_id ? `Shop ${p.shop_id}` : undefined),
    specs: compact({
      Category: [p.first_level_category_name, p.second_level_category_name].filter(Boolean).join(" › ") || undefined,
      "Positive feedback": positive !== undefined ? `${positive}%` : undefined,
      Discount: p.discount,
    }) as Record<string, string>,
    salesVolume: toNumber(p.lastest_volume),
    via: "api",
  } as Product);
}

export function aliexpressIdFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/item\/(\d+)\.html/)?.[1] ?? url.pathname.match(/\/(\d{10,})\.html/)?.[1];
}

const SORT: Record<string, string | undefined> = {
  price_asc: "SALE_PRICE_ASC",
  price_desc: "SALE_PRICE_DESC",
  relevance: undefined,
  rating: "LAST_VOLUME_DESC", // closest available: best sellers
};

export const aliexpress: Provider = {
  id: "aliexpress",
  name: "AliExpress",
  setup: "Free. Join AliExpress Portals (affiliate) + create an app at openservice.aliexpress.com → ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID.",
  isConfigured: () => Boolean(config.aliexpress.appKey && config.aliexpress.appSecret),

  async search(q) {
    const limit = q.limit ?? 10;
    const result = await call("aliexpress.affiliate.product.query", {
      keywords: q.query,
      page_no: 1,
      // Ask for extra so client-side price filtering still leaves enough results.
      page_size: Math.min(q.minPrice !== undefined || q.maxPrice !== undefined ? limit * 3 : limit, 50),
      sort: SORT[q.sort ?? "relevance"],
      target_currency: config.currency,
      target_language: config.aliexpress.language,
      ship_to_country: config.country,
      tracking_id: config.aliexpress.trackingId,
    });
    return (result?.products?.product ?? [])
      .map(mapAliExpressProduct)
      .filter((p: Product) => inPriceRange(p.price?.amount, q))
      .slice(0, limit);
  },

  matchesUrl: (url) => /(^|\.)aliexpress\.[a-z.]+$/.test(url.hostname) && Boolean(aliexpressIdFromUrl(url)),

  async getByUrl(url) {
    const id = aliexpressIdFromUrl(url);
    if (!id) return null;
    const result = await call("aliexpress.affiliate.productdetail.get", {
      product_ids: id,
      target_currency: config.currency,
      target_language: config.aliexpress.language,
      country: config.country,
      tracking_id: config.aliexpress.trackingId,
    });
    const p = result?.products?.product?.[0];
    return p ? mapAliExpressProduct(p) : null;
  },
};
