/**
 * Best Buy Products API (free API key): https://developer.bestbuy.com
 * Query syntax: /v1/products(search=word1&search=word2&salePrice>=10)?apiKey=…
 */
import { config } from "../config.js";
import { compact, fetchJson, toNumber } from "../lib/http.js";
import type { Product, Provider } from "../types.js";

const BASE = "https://api.bestbuy.com/v1/products";
const FIELDS = [
  "sku", "name", "salePrice", "regularPrice", "url", "image", "largeFrontImage", "alternateViewsImage",
  "customerReviewAverage", "customerReviewCount", "manufacturer", "modelNumber", "upc", "shortDescription",
  "onlineAvailability", "condition", "freeShipping", "features.feature", "details.name", "details.value",
].join(",");

export function mapBestBuyProduct(p: any): Product {
  const specs: Record<string, string> = {};
  for (const d of p.details ?? []) if (d?.name && d?.value) specs[d.name] = d.value;
  const sale = toNumber(p.salePrice);
  const regular = toNumber(p.regularPrice);
  const images = [p.largeFrontImage, p.image, p.alternateViewsImage].filter(Boolean);

  return compact({
    id: `bestbuy:${p.sku}`,
    source: "bestbuy",
    sourceId: String(p.sku),
    store: "Best Buy",
    title: p.name,
    url: p.url ?? `https://www.bestbuy.com/site/${p.sku}.p?skuId=${p.sku}`,
    imageUrl: images[0],
    images: [...new Set(images)],
    price: sale !== undefined ? { amount: sale, currency: "USD" } : undefined,
    originalPrice: regular !== undefined && sale !== undefined && regular > sale ? { amount: regular, currency: "USD" } : undefined,
    rating: toNumber(p.customerReviewAverage),
    reviewCount: toNumber(p.customerReviewCount),
    brand: p.manufacturer,
    condition: p.condition,
    availability: p.onlineAvailability === undefined ? undefined : p.onlineAvailability ? "In stock online" : "Not available online",
    shipping: p.freeShipping ? "Free shipping" : undefined,
    description: p.shortDescription,
    features: (p.features ?? []).map((f: any) => f.feature).filter(Boolean),
    specs: Object.keys(specs).length ? specs : undefined,
    identifiers: compact({ upc: p.upc, model: p.modelNumber, sku: String(p.sku) }),
    via: "api",
  } as Product);
}

export function bestBuySkuFromUrl(url: URL): string | undefined {
  return url.searchParams.get("skuId") ?? url.pathname.match(/\/(\d{7})\.p\b/)?.[1] ?? url.pathname.match(/\/sku\/(\d{7})/)?.[1] ?? undefined;
}

/** Best Buy search terms can't contain characters that break its query syntax. */
const cleanTerm = (t: string) => t.replace(/[^\p{L}\p{N}\-]/gu, "");

const SORT: Record<string, string | undefined> = {
  price_asc: "salePrice.asc",
  price_desc: "salePrice.dsc",
  rating: "customerReviewAverage.dsc",
  relevance: undefined,
};

export const bestbuy: Provider = {
  id: "bestbuy",
  name: "Best Buy",
  setup: "Free. Get a key at developer.bestbuy.com → BESTBUY_API_KEY.",
  isConfigured: () => Boolean(config.bestbuy.apiKey),

  async search(q) {
    const terms = q.query.split(/\s+/).map(cleanTerm).filter(Boolean);
    const filters = terms.map((t) => `search=${encodeURIComponent(t)}`);
    if (q.minPrice !== undefined) filters.push(`salePrice>=${q.minPrice}`);
    if (q.maxPrice !== undefined) filters.push(`salePrice<=${q.maxPrice}`);
    const params = new URLSearchParams({ apiKey: config.bestbuy.apiKey, format: "json", show: FIELDS, pageSize: String(q.limit ?? 10) });
    const sort = SORT[q.sort ?? "relevance"];
    if (sort) params.set("sort", sort);
    const data = await fetchJson(`${BASE}(${filters.join("&")})?${params}`);
    return (data.products ?? []).map(mapBestBuyProduct);
  },

  matchesUrl: (url) => /(^|\.)bestbuy\.com$/.test(url.hostname) && Boolean(bestBuySkuFromUrl(url)),

  async getByUrl(url) {
    const sku = bestBuySkuFromUrl(url);
    if (!sku) return null;
    const params = new URLSearchParams({ apiKey: config.bestbuy.apiKey, format: "json", show: FIELDS });
    return mapBestBuyProduct(await fetchJson(`${BASE}/${sku}.json?${params}`));
  },
};
