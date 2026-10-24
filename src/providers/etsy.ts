/**
 * Etsy Open API v3 (free API key): https://developers.etsy.com/documentation
 * Search returns listings without images, so we fetch images in one batch call.
 */
import { config } from "../config.js";
import { compact, fetchJson } from "../lib/http.js";
import type { Money, Product, Provider } from "../types.js";

const BASE = "https://openapi.etsy.com/v3/application";

/** Etsy now expects "keystring:shared_secret" in x-api-key; older apps used just the keystring. */
const apiKeyHeader = () =>
  config.etsy.sharedSecret ? `${config.etsy.apiKey}:${config.etsy.sharedSecret}` : config.etsy.apiKey;

const get = (path: string) => fetchJson(`${BASE}${path}`, { headers: { "x-api-key": apiKeyHeader() } });

const money = (p: any): Money | undefined =>
  p?.amount !== undefined && p?.divisor ? { amount: p.amount / p.divisor, currency: p.currency_code } : undefined;

const decode = (s: string | undefined) =>
  s?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export function mapEtsyListing(l: any): Product {
  const images = (l.images ?? []).map((i: any) => i.url_fullxfull ?? i.url_570xN).filter(Boolean);
  return compact({
    id: `etsy:${l.listing_id}`,
    source: "etsy",
    sourceId: String(l.listing_id),
    store: "Etsy",
    title: decode(l.title),
    url: l.url ?? `https://www.etsy.com/listing/${l.listing_id}`,
    imageUrl: images[0],
    images,
    price: money(l.price),
    seller: l.shop?.shop_name ?? (l.shop_id ? `Shop ${l.shop_id}` : undefined),
    description: decode(l.description)?.slice(0, 600),
    features: l.tags?.length ? l.tags.slice(0, 10) : undefined,
    availability: l.quantity !== undefined ? `${l.quantity} available` : undefined,
    via: "api",
  } as Product);
}

export function etsyIdFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/listing\/(\d+)/)?.[1];
}

async function withImages(listings: any[]): Promise<any[]> {
  if (!listings.length) return listings;
  const ids = listings.map((l) => l.listing_id).join(",");
  try {
    const batch = await get(`/listings/batch?listing_ids=${ids}&includes=Images,Shop`);
    const byId = new Map<number, any>((batch.results ?? []).map((l: any) => [l.listing_id, l]));
    return listings.map((l) => ({ ...l, ...byId.get(l.listing_id) }));
  } catch {
    return listings; // still useful without images
  }
}

const SORT: Record<string, [string, string] | undefined> = {
  price_asc: ["price", "asc"],
  price_desc: ["price", "desc"],
  relevance: ["score", "desc"],
  rating: undefined,
};

export const etsy: Provider = {
  id: "etsy",
  name: "Etsy",
  setup: "Free. Create an app at etsy.com/developers → ETSY_API_KEY (+ ETSY_SHARED_SECRET).",
  isConfigured: () => Boolean(config.etsy.apiKey),

  async search(q) {
    const params = new URLSearchParams({ keywords: q.query, limit: String(Math.min(q.limit ?? 10, 100)) });
    const sort = SORT[q.sort ?? "relevance"];
    if (sort) {
      params.set("sort_on", sort[0]);
      params.set("sort_order", sort[1]);
    }
    if (q.minPrice !== undefined) params.set("min_price", String(q.minPrice));
    if (q.maxPrice !== undefined) params.set("max_price", String(q.maxPrice));
    const data = await get(`/listings/active?${params}`);
    return (await withImages(data.results ?? [])).map(mapEtsyListing);
  },

  matchesUrl: (url) => /(^|\.)etsy\.com$/.test(url.hostname) && Boolean(etsyIdFromUrl(url)),

  async getByUrl(url) {
    const id = etsyIdFromUrl(url);
    if (!id) return null;
    const listing = await get(`/listings/${id}?includes=Images,Shop`);
    return mapEtsyListing(listing);
  },
};
