/**
 * Amazon Creators API — the replacement for Product Advertising API 5.0 (PA-API 5 is being shut off).
 * Docs: https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction
 *
 * Free, but you need an Amazon Associates account, and Amazon only grants API
 * access once the account has made qualifying sales. Until then this provider falls
 * back to SerpApi's Amazon search (if SERPAPI_API_KEY is set), and pasted
 * Amazon links are read from the page itself.
 *
 * Auth: OAuth client-credentials token from Login with Amazon (credential v3.x)
 * or Cognito (older v2.x credentials), sent as a Bearer token.
 */
import { config } from "../config.js";
import { TokenCache } from "../lib/cache.js";
import { compact, fetchJson, toNumber } from "../lib/http.js";
import type { Money, Product, Provider } from "../types.js";
import { serpAmazonSearch, serpConfigured } from "./serpapi.js";

const API_HOST = "https://creatorsapi.amazon";

const TOKEN_ENDPOINTS: Record<string, string> = {
  "2.1": "https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token",
  "2.2": "https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token",
  "2.3": "https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token",
  "3.1": "https://api.amazon.com/auth/o2/token",
  "3.2": "https://api.amazon.co.uk/auth/o2/token",
  "3.3": "https://api.amazon.co.jp/auth/o2/token",
};

const isLwa = () => config.amazon.credentialVersion.startsWith("3.");

const tokens = new TokenCache(async () => {
  const version = config.amazon.credentialVersion;
  const endpoint = TOKEN_ENDPOINTS[version];
  if (!endpoint) throw new Error(`Unsupported AMAZON_CREDENTIAL_VERSION "${version}"`);
  const fields = {
    grant_type: "client_credentials",
    client_id: config.amazon.credentialId,
    client_secret: config.amazon.credentialSecret,
    scope: isLwa() ? "creatorsapi::default" : "creatorsapi/default",
  };
  const data = await fetchJson<{ access_token: string; expires_in?: number }>(endpoint, {
    method: "POST",
    headers: { "Content-Type": isLwa() ? "application/json" : "application/x-www-form-urlencoded" },
    body: isLwa() ? JSON.stringify(fields) : new URLSearchParams(fields),
  });
  return { token: data.access_token, expiresInSec: data.expires_in ?? 3600 };
});

const RESOURCES = [
  "itemInfo.title",
  "itemInfo.byLineInfo",
  "itemInfo.features",
  "itemInfo.externalIds",
  "itemInfo.manufactureInfo",
  "itemInfo.productInfo",
  "itemInfo.technicalInfo",
  "images.primary.large",
  "images.variants.large",
  "customerReviews.count",
  "customerReviews.starRating",
  "offersV2.listings.price",
  "offersV2.listings.availability",
  "offersV2.listings.condition",
  "offersV2.listings.merchantInfo",
  "offersV2.listings.isBuyBoxWinner",
];

async function call(operation: "searchItems" | "getItems", body: Record<string, unknown>): Promise<any> {
  const token = await tokens.get();
  return fetchJson(`${API_HOST}/catalog/v1/${operation}`, {
    method: "POST",
    headers: {
      Authorization: isLwa() ? `Bearer ${token}` : `Bearer ${token}, Version ${config.amazon.credentialVersion}`,
      "x-marketplace": config.amazon.marketplace,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ partnerTag: config.amazon.partnerTag, resources: RESOURCES, ...body }),
  });
}

const money = (m: any): Money | undefined =>
  m?.amount !== undefined ? { amount: Number(m.amount), currency: m.currency } : undefined;

const display = (attr: any): string | undefined => attr?.displayValue ?? undefined;

export function mapAmazonItem(item: any): Product {
  const info = item.itemInfo ?? {};
  const listing = item.offersV2?.listings?.find((l: any) => l.isBuyBoxWinner) ?? item.offersV2?.listings?.[0];
  const img = (t: any) => t?.large?.url ?? t?.hiRes?.url ?? t?.highRes?.url ?? t?.medium?.url;
  const images = [img(item.images?.primary), ...(item.images?.variants ?? []).map(img)].filter(Boolean);

  const specs: Record<string, string> = {};
  for (const group of [info.productInfo, info.technicalInfo, info.manufactureInfo]) {
    for (const [key, attr] of Object.entries<any>(group ?? {})) {
      const v = attr?.displayValue ?? attr?.displayValues?.join(", ");
      if (v !== undefined && typeof v !== "object") specs[attr.label ?? key] = String(v);
    }
  }

  return compact({
    id: `amazon:${item.asin}`,
    source: "amazon",
    sourceId: item.asin,
    store: "Amazon",
    title: display(info.title) ?? item.asin,
    url: item.detailPageURL ?? `https://${config.amazon.marketplace}/dp/${item.asin}`,
    imageUrl: images[0],
    images,
    price: money(listing?.price?.money),
    originalPrice: money(listing?.price?.savingBasis?.money),
    rating: toNumber(item.customerReviews?.starRating?.value),
    reviewCount: toNumber(item.customerReviews?.count),
    brand: display(info.byLineInfo?.brand) ?? display(info.byLineInfo?.manufacturer),
    seller: listing?.merchantInfo?.name,
    condition: listing?.condition?.value ?? display(listing?.condition),
    availability: listing?.availability?.message,
    features: info.features?.displayValues,
    specs: Object.keys(specs).length ? specs : undefined,
    identifiers: compact({
      asin: item.asin,
      upc: info.externalIds?.upcs?.displayValues?.[0],
      ean: info.externalIds?.eans?.displayValues?.[0],
      model: display(info.manufactureInfo?.model),
    }),
    via: "api",
  } as Product);
}

/** Pulls the 10-character ASIN out of any Amazon product URL format. */
export function asinFromUrl(url: URL): string | undefined {
  const m = url.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|o\/asin)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return m?.[1]?.toUpperCase();
}

const officialConfigured = () =>
  Boolean(config.amazon.credentialId && config.amazon.credentialSecret && config.amazon.partnerTag);

const SORT: Record<string, string | undefined> = {
  relevance: "Relevance",
  price_asc: "Price:LowToHigh",
  price_desc: "Price:HighToLow",
  rating: "AvgCustomerReviews",
};

export const amazon: Provider = {
  id: "amazon",
  name: "Amazon",
  setup:
    "Official: Amazon Associates → Creators API credentials → AMAZON_CREDENTIAL_ID, AMAZON_CREDENTIAL_SECRET, AMAZON_PARTNER_TAG. " +
    "Until Amazon approves you, SERPAPI_API_KEY is used instead.",
  isConfigured: () => officialConfigured() || serpConfigured(),

  async search(q) {
    if (!officialConfigured()) return serpAmazonSearch(q);
    // Amazon's price filters are in the smallest currency unit (cents).
    const data = await call("searchItems", compact({
      keywords: q.query,
      itemCount: Math.min(q.limit ?? 10, 10),
      sortBy: SORT[q.sort ?? "relevance"],
      minPrice: q.minPrice !== undefined ? Math.round(q.minPrice * 100) : undefined,
      maxPrice: q.maxPrice !== undefined ? Math.round(q.maxPrice * 100) : undefined,
    }));
    return (data.searchResult?.items ?? []).map(mapAmazonItem);
  },

  matchesUrl: (url) => /(^|\.)amazon\.[a-z.]+$/.test(url.hostname) && Boolean(asinFromUrl(url)),

  async getByUrl(url) {
    // Without official access, return null so the link gets read from the page instead.
    if (!officialConfigured()) return null;
    const asin = asinFromUrl(url);
    if (!asin) return null;
    const data = await call("getItems", { itemIds: [asin] });
    const item = data.itemsResult?.items?.[0];
    return item ? mapAmazonItem(item) : null;
  },
};
