/**
 * eBay Browse API (free; needs an eBay developer account).
 * Docs: https://developer.ebay.com/api-docs/buy/browse/overview.html
 *
 * Auth: OAuth "client credentials" app token, cached ~2h.
 * Also supports search by image (POST item_summary/search_by_image).
 */
import { config } from "../config.js";
import { TokenCache } from "../lib/cache.js";
import { compact, fetchJson, toNumber } from "../lib/http.js";
import type { ImageInput, Money, Product, Provider, SearchQuery } from "../types.js";

const host = () => (config.ebay.sandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com");

const tokens = new TokenCache(async () => {
  const basic = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");
  const data = await fetchJson<{ access_token: string; expires_in: number }>(`${host()}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: "https://api.ebay.com/oauth/api_scope" }),
  });
  return { token: data.access_token, expiresInSec: data.expires_in };
});

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${await tokens.get()}`,
    "X-EBAY-C-MARKETPLACE-ID": config.ebay.marketplaceId,
    "Content-Type": "application/json",
  };
  if (config.ebay.campaignId) h["X-EBAY-C-ENDUSERCTX"] = `affiliateCampaignId=${config.ebay.campaignId}`;
  return h;
}

const SORTS: Record<string, string | undefined> = { price_asc: "price", price_desc: "-price", relevance: undefined, rating: undefined };

function buildFilter(q: SearchQuery): string | undefined {
  if (q.minPrice === undefined && q.maxPrice === undefined) return undefined;
  return `price:[${q.minPrice ?? ""}..${q.maxPrice ?? ""}],priceCurrency:${config.currency}`;
}

const money = (p: any): Money | undefined =>
  p?.value !== undefined ? { amount: Number(p.value), currency: p.currency } : undefined;

export function mapEbayItem(item: any): Product {
  const legacyId = item.legacyItemId ?? String(item.itemId ?? "").split("|")[1] ?? item.itemId;
  const images = [item.image?.imageUrl, ...(item.additionalImages ?? []).map((i: any) => i.imageUrl)].filter(Boolean);
  const specs: Record<string, string> = {};
  for (const a of item.localizedAspects ?? []) if (a?.name && a?.value) specs[a.name] = a.value;
  const shipping = item.shippingOptions?.[0]?.shippingCost;

  return compact({
    id: `ebay:${legacyId}`,
    source: "ebay",
    sourceId: String(legacyId),
    store: "eBay",
    title: item.title,
    url: item.itemAffiliateWebUrl ?? item.itemWebUrl,
    imageUrl: images[0],
    images,
    price: money(item.price),
    originalPrice: money(item.marketingPrice?.originalPrice),
    brand: item.brand,
    seller: item.seller?.username
      ? `${item.seller.username}${item.seller.feedbackPercentage ? ` (${item.seller.feedbackPercentage}% positive)` : ""}`
      : undefined,
    condition: item.condition,
    shipping: shipping ? (Number(shipping.value) === 0 ? "Free shipping" : `${shipping.value} ${shipping.currency} shipping`) : undefined,
    description: item.shortDescription,
    specs: Object.keys(specs).length ? specs : undefined,
    rating: toNumber(item.product?.averageRating ?? item.reviewRating?.averageRating),
    reviewCount: toNumber(item.reviewRating?.reviewCount),
    identifiers: compact({ gtin: item.gtin, mpn: item.mpn, upc: item.product?.gtins?.[0] }),
    via: "api",
  } as Product);
}

export function ebayItemIdFromUrl(url: URL): string | undefined {
  return url.pathname.match(/\/itm\/(?:[^/]+\/)?(\d{9,15})/)?.[1] ?? url.searchParams.get("item") ?? undefined;
}

export const ebay: Provider = {
  id: "ebay",
  name: "eBay",
  setup: "Free. Create an app at developer.ebay.com → set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET (production keys).",
  isConfigured: () => Boolean(config.ebay.clientId && config.ebay.clientSecret),

  async search(q) {
    const params = new URLSearchParams({ q: q.query, limit: String(q.limit ?? 10) });
    const filter = buildFilter(q);
    if (filter) params.set("filter", filter);
    const sort = SORTS[q.sort ?? "relevance"];
    if (sort) params.set("sort", sort);
    const data = await fetchJson(`${host()}/buy/browse/v1/item_summary/search?${params}`, { headers: await headers() });
    return (data.itemSummaries ?? []).map(mapEbayItem);
  },

  matchesUrl: (url) => /(^|\.)ebay\.[a-z.]+$/.test(url.hostname) && Boolean(ebayItemIdFromUrl(url)),

  async getByUrl(url) {
    const id = ebayItemIdFromUrl(url);
    if (!id) return null;
    const data = await fetchJson(
      `${host()}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(id)}`,
      { headers: await headers() },
    );
    return mapEbayItem(data);
  },

  async searchByImage(image: ImageInput, limit) {
    const data = await fetchJson(`${host()}/buy/browse/v1/item_summary/search_by_image?limit=${limit}`, {
      method: "POST",
      headers: await headers(),
      body: JSON.stringify({ image: image.base64 }),
    });
    return (data.itemSummaries ?? []).map(mapEbayItem);
  },
};
