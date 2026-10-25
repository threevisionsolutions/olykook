/**
 * The one product shape every store gets converted into.
 * The AI chat layer only ever sees this, never raw store responses.
 */

export type SourceId =
  | "amazon"
  | "ebay"
  | "aliexpress"
  | "walmart"
  | "bestbuy"
  | "etsy"
  | "google_shopping"
  | "shopify" // Shopify Global Catalog: every Shopify store, no key needed
  | "web"; // any other site, read from the page itself

export interface Money {
  amount: number;
  currency: string; // ISO 4217, e.g. "USD"
}

export interface ProductIdentifiers {
  asin?: string;
  upc?: string;
  ean?: string;
  gtin?: string;
  mpn?: string;
  model?: string;
  sku?: string;
  /** Shopify's Universal Product ID: the same product across different Shopify stores. */
  upid?: string;
}

export interface Product {
  /** Stable id: `${source}:${sourceId}` */
  id: string;
  source: SourceId;
  sourceId: string;
  /** The store the item is sold by (for Google Shopping this is e.g. "Target"). */
  store: string;
  title: string;
  /** Link to the product page (an affiliate link when one is configured). */
  url: string;
  imageUrl?: string;
  images?: string[];
  price?: Money;
  /** List price / price before discount, when the store reports one. */
  originalPrice?: Money;
  /** 0–5 stars. */
  rating?: number;
  reviewCount?: number;
  brand?: string;
  seller?: string;
  condition?: string;
  availability?: string;
  shipping?: string;
  description?: string;
  features?: string[];
  /** Specs as name → value, e.g. { "Screen Size": "6.1 in" }. */
  specs?: Record<string, string>;
  identifiers?: ProductIdentifiers;
  /** Units sold recently, when the store exposes it (AliExpress). */
  salesVolume?: number;
  /** How we got this data. */
  via: "api" | "serpapi" | "page";
}

export type SortOrder = "relevance" | "price_asc" | "price_desc" | "rating";

export interface SearchQuery {
  query: string;
  limit?: number; // per provider
  minPrice?: number;
  maxPrice?: number;
  sort?: SortOrder;
}

export interface ImageInput {
  /** Base64 without the data: prefix. */
  base64: string;
  mimeType: string;
  /** Public URL of the same image, if there is one (enables Google Lens). */
  url?: string;
}

export interface Provider {
  id: SourceId;
  name: string;
  /** Short note on what credentials are needed, shown by /api/providers. */
  setup: string;
  isConfigured(): boolean;
  search(q: SearchQuery): Promise<Product[]>;
  /** Can this provider look up a product from this store link? */
  matchesUrl?(url: URL): boolean;
  getByUrl?(url: URL): Promise<Product | null>;
  searchByImage?(image: ImageInput, limit: number): Promise<Product[]>;
}

export interface ProviderRunReport {
  provider: SourceId;
  status: "ok" | "error" | "skipped";
  count: number;
  ms: number;
  error?: string;
}
