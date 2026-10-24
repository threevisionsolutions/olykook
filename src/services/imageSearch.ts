/**
 * "Upload a photo, find where to buy it."
 *
 * Runs three things in parallel and merges them:
 *  - eBay's native image search (visual match),
 *  - Google Lens via SerpApi (only if the image has a public URL),
 *  - Claude describes the photo → normal text search on every other store.
 */
import { describeProductImage, visionConfigured, type ImageDescription } from "../ai/describeImage.js";
import { providers as allProviders } from "../providers/index.js";
import type { ImageInput, Product, ProviderRunReport } from "../types.js";
import { groupSameProduct, interleave, runProviders, searchAll, type SearchResult } from "./search.js";

export interface ImageSearchResult extends Omit<SearchResult, "query"> {
  description?: ImageDescription;
  query?: string;
}

export async function searchByImage(image: ImageInput, opts: { limit?: number; hint?: string } = {}): Promise<ImageSearchResult> {
  const limit = opts.limit ?? 10;
  const visual = allProviders.filter((p) => p.searchByImage);
  const visualActive = visual.filter((p) => p.isConfigured());

  const [visualRun, described] = await Promise.all([
    runProviders(visualActive, [], (p) => p.searchByImage!(image, limit)),
    visionConfigured()
      ? describeProductImage(image, opts.hint).catch((err: Error) => err)
      : Promise.resolve(new Error("ANTHROPIC_API_KEY not set")),
  ]);

  const reports: ProviderRunReport[] = [...visualRun.reports];
  let textResults: Product[] = [];
  let description: ImageDescription | undefined;
  let query: string | undefined;

  if (described instanceof Error) {
    reports.push({ provider: "web", status: visionConfigured() ? "error" : "skipped", count: 0, ms: 0, error: `Photo description: ${described.message}` });
  } else if (!described.is_product) {
    description = described;
  } else {
    description = described;
    query = opts.hint ? `${described.search_query} ${opts.hint}` : described.search_query;
    const text = await searchAll({ query, limit });
    textResults = text.products;
    reports.push(...text.providers);
  }

  // Visual matches first: they're usually the closest look-alikes.
  const products = dedupe([...interleave(visualRun.products), ...textResults]);
  return { description, query, products, sameProductGroups: groupSameProduct(products), providers: reports };
}

function dedupe(products: Product[]): Product[] {
  const seen = new Set<string>();
  return products.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
