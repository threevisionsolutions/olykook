/**
 * Shopify Global Catalog: one search across every Shopify store (millions of brands
 * and shops, e.g. Allbirds, Skullcandy, Stanley, Gymshark). Works with NO API key.
 * Docs: https://shopify.dev/docs/agents/catalog/global-catalog
 *
 * - Text search, photo search (visual similarity), and lookup of pasted Shopify product links.
 * - Without credentials, requests use Shopify's shared anonymous lane (fine for testing,
 *   throughput not guaranteed). A free Dev Dashboard "Catalogs" API key gives 5 requests/second.
 *
 * Protocol: JSON-RPC "tools/call" over HTTP (MCP), Universal Commerce Protocol (UCP) shapes.
 * Prices are in minor units (cents).
 */
import { config } from "../config.js";
import { TokenCache } from "../lib/cache.js";
import { compact, fetchJson, toNumber } from "../lib/http.js";
import type { ImageInput, Money, Product, Provider, SearchQuery } from "../types.js";

const ENDPOINT = "https://catalog.shopify.com/api/ucp/mcp";

const tokens = new TokenCache(async () => {
  const data = await fetchJson<{ access_token: string; expires_in?: number }>("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.shopify.clientId, client_secret: config.shopify.clientSecret, grant_type: "client_credentials" }),
  });
  return { token: data.access_token, expiresInSec: data.expires_in ?? 3600 };
});

const hasCredentials = () => Boolean(config.shopify.clientId && config.shopify.clientSecret);

let rpcId = 0;

async function callTool(name: string, catalog: Record<string, unknown>): Promise<any> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hasCredentials()) headers.Authorization = `Bearer ${await tokens.get()}`;
  const data = await fetchJson(ENDPOINT, {
    method: "POST",
    headers,
    timeoutMs: 25_000,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      id: ++rpcId,
      params: { name, arguments: { meta: { "ucp-agent": { profile: config.shopify.profileUrl } }, catalog } },
    }),
  });
  if (data.error) throw new Error(`Shopify Catalog: ${data.error.message ?? "error"}${data.error.data ? ` (${data.error.data})` : ""}`);
  if (data.result?.isError) {
    const text = data.result.content?.map((c: any) => c.text).join(" ") ?? "tool error";
    throw new Error(`Shopify Catalog: ${text}`);
  }
  return data.result?.structuredContent ?? {};
}

/** Minor units → amount, respecting currencies without cents (JPY, KRW…). */
export function fromMinor(m: any): Money | undefined {
  const amount = toNumber(m?.amount);
  if (amount === undefined || !m?.currency) return undefined;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: m.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* unknown currency code: assume cents */
  }
  return { amount: amount / 10 ** digits, currency: m.currency };
}

/** "Driver Size: 40 mm" → ["Driver Size", "40 mm"] */
function specsFrom(lines: unknown): Record<string, string> | undefined {
  if (!Array.isArray(lines)) return undefined;
  const specs: Record<string, string> = {};
  for (const line of lines) {
    const m = String(line).match(/^([^:]{1,60}):\s*(.+)$/);
    if (m) specs[m[1].trim()] = m[2].trim();
  }
  return Object.keys(specs).length ? specs : undefined;
}

/** Strip HTML from Shopify's description. */
const plain = (d: any): string | undefined =>
  (d?.plain ?? d?.html ?? (typeof d === "string" ? d : undefined))
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim() || undefined;

export function mapShopifyProduct(p: any, preferHost?: string): Product {
  const variants: any[] = p.variants ?? [];
  const variant =
    (preferHost && variants.find((v) => hostOf(v.seller?.url) === preferHost || hostOf(v.url) === preferHost)) ?? variants[0] ?? {};
  const seller = variant.seller ?? {};
  const images = [...(variant.media ?? []), ...(p.media ?? [])].filter((m: any) => m?.type === "image" && m.url).map((m: any) => m.url);
  const rating = p.rating ?? variant.rating;
  const scale = toNumber(rating?.scale_max) ?? 5;
  const price = fromMinor(variant.price) ?? fromMinor(p.price_range?.min);
  const list = fromMinor(variant.list_price);
  const md = p.metadata ?? {};
  const availability = variant.availability;

  return compact({
    id: `shopify:${p.id}`,
    source: "shopify",
    sourceId: String(p.id),
    store: seller.name ?? hostOf(seller.url) ?? "Shopify store",
    title: p.title,
    url: variant.url ?? (seller.url && p.handle ? `${seller.url}/products/${p.handle}` : seller.url),
    imageUrl: images[0],
    images: [...new Set(images)] as string[],
    price,
    originalPrice: list && price && list.amount > price.amount ? list : undefined,
    rating: toNumber(rating?.value) !== undefined ? Math.round((toNumber(rating.value)! / scale) * 5 * 10) / 10 : undefined,
    reviewCount: toNumber(rating?.count),
    seller: seller.name,
    condition: Array.isArray(variant.condition) ? variant.condition.join(", ") : variant.condition,
    availability: availability
      ? availability.available === false
        ? "Out of stock"
        : availability.running_low
          ? "Low stock"
          : "In stock"
      : undefined,
    description: plain(p.description)?.slice(0, 1200),
    features: Array.isArray(md.top_features) ? md.top_features.slice(0, 8) : undefined,
    specs: specsFrom(md.tech_specs),
    identifiers: compact({ upid: String(p.id), sku: variant.sku || undefined }),
    via: "api",
  } as Product);
}

function hostOf(u: unknown): string | undefined {
  try {
    return new URL(String(u)).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Shopify results can be priced in a store's own currency; show the shopper's currency first. */
export function preferCurrency(products: Product[], currency: string, limit: number): Product[] {
  const home = products.filter((p) => !p.price || p.price.currency === currency);
  const other = products.filter((p) => p.price && p.price.currency !== currency);
  return [...home, ...other].slice(0, limit);
}

function buildFilters(q: Partial<SearchQuery>) {
  const price: Record<string, number> = {};
  if (q.minPrice !== undefined) price.min = Math.round(q.minPrice * 100);
  if (q.maxPrice !== undefined) price.max = Math.round(q.maxPrice * 100);
  return compact({ ships_to: { country: config.country }, price: Object.keys(price).length ? price : undefined });
}

const context = () => ({ address_country: config.country, currency: config.currency });

export const shopify: Provider = {
  id: "shopify",
  name: "Shopify stores (Global Catalog)",
  setup:
    "Works with no key. For reliable speed, create a free Catalogs API key at dev.shopify.com/dashboard → " +
    "SHOPIFY_CATALOG_CLIENT_ID + SHOPIFY_CATALOG_CLIENT_SECRET.",
  isConfigured: () => !config.shopify.disabled,

  async search(q) {
    const limit = q.limit ?? 10;
    const result = await callTool("search_catalog", {
      query: q.query,
      filters: buildFilters(q),
      context: context(),
      pagination: { limit: Math.min(limit * 2, 50) }, // extra so foreign-currency results can go last
    });
    return preferCurrency((result.products ?? []).map((p: any) => mapShopifyProduct(p)), config.currency, limit);
  },

  async searchByImage(image: ImageInput, limit: number) {
    const result = await callTool("search_catalog", {
      like: [{ image: { content_type: image.mimeType, data: image.base64 } }],
      filters: buildFilters({}),
      context: context(),
      pagination: { limit: Math.min(limit * 2, 50) },
    });
    return preferCurrency((result.products ?? []).map((p: any) => mapShopifyProduct(p)), config.currency, limit);
  },

  /** Most Shopify stores use /products/<handle> links. Other sites are filtered out by the lookup itself. */
  matchesUrl: (url) => /\/products\/[^/]+/.test(url.pathname),

  async getByUrl(url) {
    const clean = `${url.origin}${url.pathname}`;
    const result = await callTool("lookup_catalog", { ids: [clean], context: context() });
    const p = result.products?.[0];
    return p ? mapShopifyProduct(p, url.hostname.replace(/^www\./, "")) : null;
  },
};
