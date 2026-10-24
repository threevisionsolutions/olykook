/**
 * SerpApi (paid, with a small free monthly quota): https://serpapi.com
 *
 * Used for three things:
 *  1. Google Shopping: one search covers hundreds of stores (Target, Home Depot, Newegg…).
 *  2. Backup for Amazon and Walmart when you don't have their official API access yet.
 *  3. Google Lens: "find this product from a photo" (needs a public image URL).
 *
 * SerpApi runs the scraping on its side and returns clean JSON, so we don't
 * have to fight Google/Amazon bot protection ourselves.
 */
import { config } from "../config.js";
import { compact, fetchJson, guessCurrency, parsePrice, toNumber } from "../lib/http.js";
import type { ImageInput, Product, Provider, SearchQuery, SourceId } from "../types.js";

export const serpConfigured = () => Boolean(config.serpapi.apiKey);

export async function serpSearch(engine: string, params: Record<string, string | number | undefined>): Promise<any> {
  const qs = new URLSearchParams({ engine, api_key: config.serpapi.apiKey, output: "json" });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
  const data = await fetchJson(`https://serpapi.com/search.json?${qs}`, { timeoutMs: 25_000 });
  if (data.error && !/hasn't returned any results/i.test(data.error)) throw new Error(`SerpApi: ${data.error}`);
  return data;
}

const price = (extracted: unknown, raw: unknown) => {
  const amount = toNumber(extracted) ?? parsePrice(raw);
  return amount !== undefined ? { amount, currency: guessCurrency(raw, config.currency) } : undefined;
};

/** Store name from Google Shopping → our SourceId, so a Walmart hit from Google is tagged "walmart". */
function sourceForStore(store: string | undefined): SourceId {
  const s = (store ?? "").toLowerCase();
  if (s.includes("amazon")) return "amazon";
  if (s.includes("walmart")) return "walmart";
  if (s.includes("ebay")) return "ebay";
  if (s.includes("best buy")) return "bestbuy";
  if (s.includes("etsy")) return "etsy";
  if (s.includes("aliexpress")) return "aliexpress";
  return "google_shopping";
}

export function mapGoogleShopping(r: any): Product {
  const id = String(r.product_id ?? r.position ?? r.title);
  return compact({
    id: `google_shopping:${id}`,
    source: "google_shopping",
    sourceId: id,
    store: r.source ?? "Google Shopping",
    title: r.title,
    url: r.link ?? r.product_link,
    imageUrl: r.thumbnail ?? r.serpapi_thumbnail,
    price: price(r.extracted_price, r.price),
    originalPrice: price(r.extracted_old_price, r.old_price),
    rating: toNumber(r.rating),
    reviewCount: toNumber(r.reviews),
    condition: r.second_hand_condition,
    shipping: r.delivery,
    via: "serpapi",
  } as Product);
}

export function mapSerpAmazon(r: any): Product {
  return compact({
    id: `amazon:${r.asin}`,
    source: "amazon",
    sourceId: r.asin,
    store: "Amazon",
    title: r.title,
    url: r.link_clean ?? r.link ?? `https://www.amazon.com/dp/${r.asin}`,
    imageUrl: r.thumbnail,
    price: price(r.extracted_price, r.price),
    originalPrice: price(r.extracted_old_price, r.old_price),
    rating: toNumber(r.rating),
    reviewCount: toNumber(r.reviews),
    shipping: Array.isArray(r.delivery) ? r.delivery.join(" · ") : r.delivery,
    identifiers: { asin: r.asin },
    via: "serpapi",
  } as Product);
}

export function mapSerpWalmart(r: any): Product {
  const offer = r.primary_offer ?? {};
  return compact({
    id: `walmart:${r.us_item_id ?? r.product_id}`,
    source: "walmart",
    sourceId: String(r.us_item_id ?? r.product_id),
    store: "Walmart",
    title: r.title,
    url: r.product_page_url ?? r.link,
    imageUrl: r.thumbnail,
    price: price(offer.offer_price ?? offer.min_price, undefined),
    rating: toNumber(r.rating),
    reviewCount: toNumber(r.reviews),
    seller: r.seller_name,
    description: r.description,
    via: "serpapi",
  } as Product);
}

export function mapLensMatch(r: any, i: number): Product {
  const src = sourceForStore(r.source);
  return compact({
    id: `${src}:lens-${i}-${encodeURIComponent(r.link ?? "").slice(-40)}`,
    source: src,
    sourceId: r.link,
    store: r.source ?? new URL(r.link).hostname,
    title: r.title,
    url: r.link,
    imageUrl: r.thumbnail ?? r.image,
    price: price(r.price?.extracted_value, r.price?.value),
    rating: toNumber(r.rating),
    reviewCount: toNumber(r.reviews),
    via: "serpapi",
  } as Product);
}

const GOOGLE_SORT: Record<string, string | undefined> = { price_asc: "p", price_desc: "pd", rating: "r", relevance: undefined };

/** Google Shopping: the "everything else" provider. */
export const googleShopping: Provider = {
  id: "google_shopping",
  name: "Google Shopping (via SerpApi)",
  setup: "Paid with a free monthly quota. Sign up at serpapi.com → set SERPAPI_API_KEY.",
  isConfigured: serpConfigured,

  async search(q: SearchQuery) {
    const data = await serpSearch("google_shopping", {
      q: q.query,
      gl: config.country.toLowerCase(),
      hl: "en",
      num: q.limit ?? 10,
      min_price: q.minPrice,
      max_price: q.maxPrice,
      sort_by: GOOGLE_SORT[q.sort ?? "relevance"],
    });
    const results = [...(data.shopping_results ?? []), ...(data.inline_shopping_results ?? [])];
    return results.slice(0, q.limit ?? 10).map(mapGoogleShopping);
  },

  /** Google Lens visual search. Only works when the image has a public URL. */
  async searchByImage(image: ImageInput, limit: number) {
    if (!image.url) return [];
    const data = await serpSearch("google_lens", { url: image.url, country: config.country.toLowerCase() });
    return (data.visual_matches ?? [])
      .filter((r: any) => r.link)
      .slice(0, limit)
      .map(mapLensMatch);
  },
};

export async function serpAmazonSearch(q: SearchQuery): Promise<Product[]> {
  const sort = { price_asc: "price-asc-rank", price_desc: "price-desc-rank", rating: "review-rank", relevance: undefined }[
    q.sort ?? "relevance"
  ];
  const data = await serpSearch("amazon", { k: q.query, amazon_domain: config.amazon.marketplace.replace(/^www\./, ""), s: sort });
  return (data.organic_results ?? [])
    .filter((r: any) => r.asin)
    .filter((r: any) => inPriceRange(toNumber(r.extracted_price), q))
    .slice(0, q.limit ?? 10)
    .map(mapSerpAmazon);
}

export async function serpWalmartSearch(q: SearchQuery): Promise<Product[]> {
  const sort = { price_asc: "price_low", price_desc: "price_high", rating: "rating_high", relevance: undefined }[q.sort ?? "relevance"];
  const data = await serpSearch("walmart", { query: q.query, sort, min_price: q.minPrice, max_price: q.maxPrice });
  return (data.organic_results ?? []).slice(0, q.limit ?? 10).map(mapSerpWalmart);
}

export function inPriceRange(amount: number | undefined, q: SearchQuery): boolean {
  if (amount === undefined) return true;
  if (q.minPrice !== undefined && amount < q.minPrice) return false;
  if (q.maxPrice !== undefined && amount > q.maxPrice) return false;
  return true;
}
