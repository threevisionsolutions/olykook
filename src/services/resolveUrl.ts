/**
 * Turns pasted product links into Products, for the "compare these links" feature.
 *
 * 1. If the link belongs to a store with a configured API (eBay, Amazon, AliExpress…),
 *    ask the API: accurate price, stock and an affiliate link.
 * 2. Otherwise (or if the API fails), fetch the page and read its product data.
 */
import { TtlCache } from "../lib/cache.js";
import { providers as allProviders } from "../providers/index.js";
import { BlockedPageError, extractProduct } from "../scrape/extract.js";
import { BlockedUrlError, fetchPage } from "../scrape/fetchPage.js";
import type { Product, Provider } from "../types.js";

const cache = new TtlCache<Product>(30 * 60_000);

export interface ResolvedLink {
  input: string;
  product?: Product;
  error?: string;
}

export interface ResolveOptions {
  providerList?: Provider[];
  fetcher?: typeof fetchPage;
}

/** Strip tracking junk so the same product pasted twice hits the cache. */
export function normalizeUrl(raw: string): URL {
  const url = new URL(raw.trim().match(/^https?:\/\//i) ? raw.trim() : `https://${raw.trim()}`);
  for (const k of [...url.searchParams.keys()]) {
    if (/^(utm_|ref|ref_|tag$|fbclid|gclid|_trkparms|_trksid|spm|scm|pd_rd|pf_rd|psc$|th$|qid$|sr$|keywords$|crid$|sprefix$)/i.test(k)) {
      url.searchParams.delete(k);
    }
  }
  url.hash = "";
  if (!url.hostname.includes(".")) throw new TypeError("Not a link");
  return url;
}

export async function resolveUrl(raw: string, opts: ResolveOptions = {}): Promise<ResolvedLink> {
  let url: URL;
  try {
    url = normalizeUrl(raw);
  } catch {
    return { input: raw, error: "That doesn't look like a link" };
  }

  const cached = cache.get(url.href);
  if (cached) return { input: raw, product: cached };

  const pool = opts.providerList ?? allProviders;
  const fetcher = opts.fetcher ?? fetchPage;
  let apiError: string | undefined;

  // Short links (amzn.to, ebay.us, a.aliexpress.com) need expanding before we can match a store.
  let target = url;
  let page: { finalUrl: URL; html: string } | undefined;
  const needsExpanding = !pool.some((p) => p.matchesUrl?.(url));
  if (needsExpanding) {
    try {
      page = await fetcher(url.href);
      target = normalizeUrl(page.finalUrl.href);
    } catch (err) {
      return { input: raw, error: friendlyError(err) };
    }
  }

  const provider = pool.find((p) => p.isConfigured() && p.getByUrl && p.matchesUrl?.(target));
  if (provider) {
    try {
      const product = await provider.getByUrl!(target);
      if (product) {
        cache.set(url.href, product);
        return { input: raw, product };
      }
    } catch (err) {
      apiError = err instanceof Error ? err.message : String(err);
      console.warn(`[resolve] ${provider.id} API failed for ${target.href}: ${apiError}`);
    }
  }

  try {
    page ??= await fetcher(target.href);
    const product = extractProduct(page.html, page.finalUrl);
    cache.set(url.href, product);
    return { input: raw, product };
  } catch (err) {
    return { input: raw, error: friendlyError(err) + (apiError ? ` (store API also failed: ${apiError})` : "") };
  }
}

function friendlyError(err: unknown): string {
  if (err instanceof BlockedUrlError) return "That link points to a private address and can't be opened";
  if (err instanceof BlockedPageError) return `${err.message}. Try again later, or add that store's API key.`;
  if (err instanceof Error && err.name === "TimeoutError") return "The store took too long to respond";
  const code = (err as any)?.code ?? (err as any)?.cause?.code;
  if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET") return "Couldn't reach that website";
  return err instanceof Error ? err.message : String(err);
}

export async function resolveUrls(urls: string[], opts: ResolveOptions = {}): Promise<ResolvedLink[]> {
  return Promise.all(urls.slice(0, 10).map((u) => resolveUrl(u, opts)));
}
