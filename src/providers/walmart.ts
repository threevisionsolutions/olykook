/**
 * Walmart Affiliate API (free; walmart.io developer account + affiliate approval).
 * Docs: https://walmart.io/docs/affiliate/onboarding-guide
 *
 * Every request is signed: RSA-SHA256 over "consumerId\ntimestamp\nkeyVersion\n"
 * with the private key whose public half you uploaded to walmart.io.
 * Falls back to SerpApi's Walmart search when only SERPAPI_API_KEY is set.
 */
import { createSign } from "node:crypto";
import { config } from "../config.js";
import { compact, fetchJson, toNumber } from "../lib/http.js";
import type { Product, Provider } from "../types.js";
import { inPriceRange, serpConfigured, serpWalmartSearch } from "./serpapi.js";

const BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

export function walmartHeaders(now = Date.now()): Record<string, string> {
  const { consumerId, keyVersion } = config.walmart;
  const timestamp = String(now);
  const signer = createSign("RSA-SHA256");
  signer.update(`${consumerId}\n${timestamp}\n${keyVersion}\n`);
  return {
    "WM_CONSUMER.ID": consumerId,
    "WM_CONSUMER.INTIMESTAMP": timestamp,
    "WM_SEC.KEY_VERSION": keyVersion,
    "WM_SEC.AUTH_SIGNATURE": signer.sign(config.walmart.privateKey, "base64"),
  };
}

function withPublisher(params: URLSearchParams): URLSearchParams {
  if (config.walmart.publisherId) params.set("publisherId", config.walmart.publisherId);
  return params;
}

export function mapWalmartItem(i: any): Product {
  const images = [i.largeImage, ...(i.imageEntities ?? []).map((e: any) => e.largeImage)].filter(Boolean);
  const unique = [...new Set(images)] as string[];
  return compact({
    id: `walmart:${i.itemId}`,
    source: "walmart",
    sourceId: String(i.itemId),
    store: "Walmart",
    title: i.name,
    url: i.productTrackingUrl ?? i.productUrl ?? `https://www.walmart.com/ip/${i.itemId}`,
    imageUrl: unique[0] ?? i.mediumImage ?? i.thumbnailImage,
    images: unique,
    price: toNumber(i.salePrice) !== undefined ? { amount: toNumber(i.salePrice)!, currency: "USD" } : undefined,
    originalPrice: toNumber(i.msrp) && toNumber(i.msrp)! > (toNumber(i.salePrice) ?? 0) ? { amount: toNumber(i.msrp)!, currency: "USD" } : undefined,
    rating: toNumber(i.customerRating),
    reviewCount: toNumber(i.numReviews),
    brand: i.brandName,
    seller: i.sellerInfo,
    availability: i.stock,
    shipping: i.freeShippingOver35Dollars || i.freeShipToStore ? "Free shipping available" : undefined,
    description: (i.shortDescription ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || undefined,
    identifiers: compact({ upc: i.upc, model: i.modelNumber }),
    via: "api",
  } as Product);
}

export function walmartIdFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/ip\/(?:[^/]+\/)?(\d{5,})/)?.[1];
}

const officialConfigured = () => Boolean(config.walmart.consumerId && config.walmart.privateKey);

const SORT: Record<string, [string, string] | undefined> = {
  price_asc: ["price", "ascending"],
  price_desc: ["price", "descending"],
  rating: ["customerRating", "descending"],
  relevance: undefined,
};

export const walmart: Provider = {
  id: "walmart",
  name: "Walmart",
  setup: "Free. walmart.io → Affiliate API → WALMART_CONSUMER_ID + WALMART_PRIVATE_KEY_PATH (+ WALMART_PUBLISHER_ID for commissions). Falls back to SERPAPI_API_KEY.",
  isConfigured: () => officialConfigured() || serpConfigured(),

  async search(q) {
    if (!officialConfigured()) return serpWalmartSearch(q);
    const params = withPublisher(new URLSearchParams({ query: q.query, numItems: String(Math.min(q.limit ?? 10, 25)) }));
    const sort = SORT[q.sort ?? "relevance"];
    if (sort) {
      params.set("sort", sort[0]);
      params.set("order", sort[1]);
    }
    const data = await fetchJson(`${BASE}/search?${params}`, { headers: walmartHeaders() });
    return (data.items ?? []).map(mapWalmartItem).filter((p: Product) => inPriceRange(p.price?.amount, q));
  },

  matchesUrl: (url) => /(^|\.)walmart\.com$/.test(url.hostname) && Boolean(walmartIdFromUrl(url)),

  async getByUrl(url) {
    if (!officialConfigured()) return null;
    const id = walmartIdFromUrl(url);
    if (!id) return null;
    const data = await fetchJson(`${BASE}/items?${withPublisher(new URLSearchParams({ ids: id }))}`, { headers: walmartHeaders() });
    const item = data.items?.[0];
    return item ? mapWalmartItem(item) : null;
  },
};
