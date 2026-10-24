/**
 * Searches every configured store at the same time and merges the results.
 * One slow or broken store never fails the whole search; its error shows up in `providers`.
 */
import { TtlCache } from "../lib/cache.js";
import { configuredProviders, providers as allProviders } from "../providers/index.js";
import type { Product, Provider, ProviderRunReport, SearchQuery, SortOrder, SourceId } from "../types.js";

const PROVIDER_TIMEOUT_MS = 20_000;
const cache = new TtlCache<Product[]>(10 * 60_000);

export interface SearchResult {
  query: SearchQuery;
  products: Product[];
  /** Same product (matching barcode) sold by several stores, cheapest first. */
  sameProductGroups: { key: string; title: string; offers: Product[] }[];
  providers: ProviderRunReport[];
}

export interface SearchOptions {
  /** Only these stores (default: all configured). */
  sources?: SourceId[];
  /** For tests: use these providers instead of the real registry. */
  providerList?: Provider[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    }),
  ]);
}

export async function runProviders(
  list: Provider[],
  skipped: Provider[],
  fn: (p: Provider) => Promise<Product[]>,
  cacheKey?: (p: Provider) => string,
): Promise<{ products: Product[][]; reports: ProviderRunReport[] }> {
  const settled = await Promise.all(
    list.map(async (p): Promise<[Product[], ProviderRunReport]> => {
      const start = Date.now();
      try {
        const key = cacheKey?.(p);
        const run = () => withTimeout(fn(p), PROVIDER_TIMEOUT_MS, p.name);
        const items = key ? await cache.getOrSet(key, run) : await run();
        return [items, { provider: p.id, status: "ok", count: items.length, ms: Date.now() - start }];
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[search] ${p.id} failed: ${message}`);
        return [[], { provider: p.id, status: "error", count: 0, ms: Date.now() - start, error: message }];
      }
    }),
  );
  const reports = settled.map(([, r]) => r);
  for (const p of skipped) reports.push({ provider: p.id, status: "skipped", count: 0, ms: 0, error: "Not configured" });
  return { products: settled.map(([items]) => items), reports };
}

/** Round-robin across stores so the first page isn't 10 results from one site. */
export function interleave(lists: Product[][]): Product[] {
  const out: Product[] = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

export function sortProducts(products: Product[], sort: SortOrder = "relevance"): Product[] {
  if (sort === "relevance") return products;
  const priced = (p: Product) => p.price?.amount ?? (sort === "price_asc" ? Infinity : -Infinity);
  const sorted = [...products];
  if (sort === "price_asc") sorted.sort((a, b) => priced(a) - priced(b));
  if (sort === "price_desc") sorted.sort((a, b) => priced(b) - priced(a));
  if (sort === "rating") {
    // Weight by review count so one 5-star review doesn't beat 4.7 stars from 10,000 reviews.
    const score = (p: Product) => (p.rating ?? 0) * Math.min(1, Math.log10((p.reviewCount ?? 0) + 1) / 3);
    sorted.sort((a, b) => score(b) - score(a));
  }
  return sorted;
}

/** UPC (12), EAN (13) and GTIN-14 are the same number family; pad to 14 digits to compare. */
export function barcodeKey(p: Product): string | undefined {
  const raw = p.identifiers?.gtin ?? p.identifiers?.upc ?? p.identifiers?.ean;
  const digits = raw?.replace(/\D/g, "");
  if (!digits || digits.length < 8 || digits.length > 14 || /^0+$/.test(digits)) return undefined;
  return digits.padStart(14, "0");
}

export function groupSameProduct(products: Product[]): SearchResult["sameProductGroups"] {
  const groups = new Map<string, Product[]>();
  for (const p of products) {
    const key = barcodeKey(p);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  return [...groups.entries()]
    .filter(([, offers]) => new Set(offers.map((o) => o.store)).size > 1)
    .map(([key, offers]) => ({
      key,
      title: offers[0].title,
      offers: [...offers].sort((a, b) => (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity)),
    }));
}

/** Drop exact duplicates (same store + same id) that can come from overlapping sources. */
function dedupe(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

export async function searchAll(query: SearchQuery, opts: SearchOptions = {}): Promise<SearchResult> {
  const pool = opts.providerList ?? allProviders;
  const wanted = pool.filter((p) => !opts.sources || opts.sources.includes(p.id));
  const active = wanted.filter((p) => p.isConfigured());
  const skipped = wanted.filter((p) => !p.isConfigured());

  const q: SearchQuery = { ...query, limit: Math.min(Math.max(query.limit ?? 10, 1), 50) };
  const keyFor = (p: Provider) => `search:${p.id}:${JSON.stringify([q.query.toLowerCase(), q.limit, q.minPrice, q.maxPrice, q.sort])}`;
  const { products, reports } = await runProviders(active, skipped, (p) => p.search(q), opts.providerList ? undefined : keyFor);

  const merged = sortProducts(dedupe(interleave(products)), q.sort);
  return { query: q, products: merged, sameProductGroups: groupSameProduct(merged), providers: reports };
}

export { configuredProviders };
