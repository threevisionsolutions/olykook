/**
 * The tools Claude can call during a chat. Each tool:
 *  - has a JSON schema Claude sees, and a Zod schema we validate its input with,
 *  - runs our existing search / link / photo services,
 *  - returns compact JSON for Claude, plus a UI event so the browser can show product cards.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "../config.js";
import { providers } from "../providers/index.js";
import { resolveUrls } from "../services/resolveUrl.js";
import { groupSameProduct, interleave, runProviders, searchAll } from "../services/search.js";
import type { Product, SourceId } from "../types.js";
import type { Conversation } from "./store.js";

export type UiEvent =
  | { type: "products"; toolUseId: string; title: string; products: Product[]; notes?: string[] }
  | { type: "recommendations"; title: string; picks: { label: string; reason: string; product: Product }[] };

export interface ToolOutcome {
  /** What Claude reads (JSON string). */
  content: string;
  isError?: boolean;
  ui?: UiEvent;
}

const STORE_IDS = providers.map((p) => p.id) as [SourceId, ...SourceId[]];
const SORTS = ["relevance", "price_asc", "price_desc", "rating"] as const;

// ── Input schemas (validated before running; tool inputs stream eagerly so the API doesn't validate them) ──

const SearchInput = z.object({
  query: z.string().min(1).max(300),
  min_price: z.number().min(0).optional(),
  max_price: z.number().min(0).optional(),
  sort: z.enum(SORTS).optional(),
  stores: z.array(z.enum(STORE_IDS)).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const LinksInput = z.object({ urls: z.array(z.string().min(4).max(2000)).min(1).max(10) });

const PhotoInput = z.object({
  photo_number: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

const RecommendInput = z.object({
  title: z.string().min(1).max(120),
  picks: z
    .array(z.object({ product_id: z.string().min(1), label: z.string().min(1).max(40), reason: z.string().min(1).max(400) }))
    .min(1)
    .max(6),
});

// ── Tool definitions Claude sees ──

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "search_products",
    description:
      "Search online stores for products matching a text query and return real listings with price, rating, review count, " +
      "availability, store and link. Use specific queries (brand, model, key feature) when you know them, and broader ones " +
      "to explore a category. Run several searches with different wording when the first results are weak or too narrow. " +
      "Results also flag the same product sold by several stores (useful for price comparison). " +
      "Stores searched by default are all the connected ones; the result says which stores ran and which failed.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search words, e.g. 'sony noise cancelling headphones' or 'linen duvet cover queen'" },
        min_price: { type: "number", description: "Minimum price in the shopper's currency" },
        max_price: { type: "number", description: "Maximum price in the shopper's currency" },
        sort: { type: "string", enum: [...SORTS], description: "Result order. Default relevance." },
        stores: {
          type: "array",
          items: { type: "string", enum: [...STORE_IDS] },
          description: "Limit to these stores. Omit to search every connected store.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Results per store (default 8)" },
      },
      required: ["query"],
    },
    eager_input_streaming: true,
  },
  {
    name: "read_product_links",
    description:
      "Fetch full details (title, price, rating, specs, features, availability, seller) for product page links the shopper " +
      "pasted. Works on most online stores. Call this whenever the shopper shares product URLs, before comparing them. " +
      "Some big stores block automated reading; the result says so for those links.",
    input_schema: {
      type: "object",
      properties: { urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Product page URLs" } },
      required: ["urls"],
    },
    eager_input_streaming: true,
  },
  {
    name: "search_by_photo",
    description:
      "Find products that look like a photo the shopper uploaded (visual match across stores, including the same item " +
      "at other sellers). Only available when the shopper has uploaded a photo in this conversation. Complement it with " +
      "search_products using your own description of the photo for broader coverage.",
    input_schema: {
      type: "object",
      properties: {
        photo_number: { type: "integer", minimum: 1, description: "Which uploaded photo, counting from 1. Default: the most recent." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Matches per store (default 8)" },
      },
    },
    eager_input_streaming: true,
  },
  {
    name: "show_recommendations",
    description:
      "Display your top picks to the shopper as highlighted product cards. Use it once you've compared options and are " +
      "ready to recommend, typically 1-4 picks with distinct labels such as 'Best overall', 'Best value', 'Premium pick'. " +
      "product_id must be an id returned by an earlier tool result in this conversation. Your written reply should still " +
      "explain the reasoning briefly; don't repeat every spec the cards already show.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Heading, e.g. 'Top picks under $150'" },
        picks: {
          type: "array",
          minItems: 1,
          maxItems: 6,
          items: {
            type: "object",
            properties: {
              product_id: { type: "string" },
              label: { type: "string", description: "Short badge, e.g. 'Best value'" },
              reason: { type: "string", description: "One or two sentences on why, grounded in the tool results" },
            },
            required: ["product_id", "label", "reason"],
          },
        },
      },
      required: ["title", "picks"],
    },
    eager_input_streaming: true,
  },
];

// ── What Claude reads: compact, so long chats stay cheap ──

const money = (m?: { amount: number; currency: string }) => (m ? `${m.amount.toFixed(2)} ${m.currency}` : undefined);

/** "$250" style amount in the shopper's currency, for labels. */
function budget(n: number): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: config.currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${n} ${config.currency}`;
  }
}

export function compactProduct(p: Product, detail: "brief" | "full" = "brief") {
  const specs = p.specs ? Object.entries(p.specs).slice(0, detail === "full" ? 25 : 6) : [];
  return JSON.parse(
    JSON.stringify({
      id: p.id,
      title: p.title,
      store: p.store,
      price: money(p.price),
      was: money(p.originalPrice),
      rating: p.rating,
      reviews: p.reviewCount,
      availability: p.availability,
      condition: p.condition,
      brand: p.brand,
      shipping: p.shipping,
      sold_recently: p.salesVolume,
      specs: specs.length ? Object.fromEntries(specs) : undefined,
      features: p.features?.slice(0, detail === "full" ? 10 : 3),
      description: detail === "full" ? p.description?.slice(0, 600) : undefined,
      url: p.url,
      data_source: p.via === "page" ? "read from the store page" : undefined,
    }),
  );
}

function remember(convo: Conversation, products: Product[]) {
  for (const p of products) convo.products.set(p.id, p);
}

function invalid(error: z.ZodError, raw: unknown): ToolOutcome {
  return {
    isError: true,
    content: JSON.stringify({ INVALID_INPUT: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`), received: raw }),
  };
}

const storeName = (id: SourceId) => providers.find((p) => p.id === id)?.name ?? id;

// ── Executors ──

export async function runTool(name: string, input: unknown, toolUseId: string, convo: Conversation): Promise<ToolOutcome> {
  switch (name) {
    case "search_products": {
      const parsed = SearchInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error, input);
      const a = parsed.data;
      const result = await searchAll(
        { query: a.query, minPrice: a.min_price, maxPrice: a.max_price, sort: a.sort, limit: a.limit ?? 8 },
        { sources: a.stores },
      );
      remember(convo, result.products);
      const failed = result.providers.filter((r) => r.status === "error");
      const notes = failed.map((r) => `${storeName(r.provider)} failed: ${r.error}`);
      const ran = result.providers.filter((r) => r.status === "ok").map((r) => storeName(r.provider));
      const priceBits = [a.min_price !== undefined && `from ${budget(a.min_price)}`, a.max_price !== undefined && `up to ${budget(a.max_price)}`].filter(Boolean);
      return {
        content: JSON.stringify({
          query: a.query,
          stores_searched: ran,
          stores_failed: notes,
          stores_not_connected: result.providers.filter((r) => r.status === "skipped").map((r) => storeName(r.provider)),
          result_count: result.products.length,
          products: result.products.map((p) => compactProduct(p)),
          same_product_at_several_stores: result.sameProductGroups.map((g) => ({
            title: g.title,
            offers: g.offers.map((o) => ({ id: o.id, store: o.store, price: money(o.price) })),
          })),
        }),
        ui: {
          type: "products",
          toolUseId,
          title: `“${a.query}”${priceBits.length ? ` (${priceBits.join(" ")})` : ""}`,
          products: result.products,
          notes,
        },
      };
    }

    case "read_product_links": {
      const parsed = LinksInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error, input);
      const results = await resolveUrls(parsed.data.urls);
      const products = results.flatMap((r) => (r.product ? [r.product] : []));
      remember(convo, products);
      return {
        content: JSON.stringify({
          links: results.map((r) => (r.product ? { link: r.input, product: compactProduct(r.product, "full") } : { link: r.input, error: r.error })),
          same_product_at_several_stores: groupSameProduct(products).map((g) => g.title),
        }),
        ui: {
          type: "products",
          toolUseId,
          title: "Your links",
          products,
          notes: results.filter((r) => r.error).map((r) => `${shortLink(r.input)}: ${r.error}`),
        },
      };
    }

    case "search_by_photo": {
      const parsed = PhotoInput.safeParse(input ?? {});
      if (!parsed.success) return invalid(parsed.error, input);
      if (!convo.photos.length) {
        return { isError: true, content: JSON.stringify({ error: "The shopper hasn't uploaded a photo in this conversation." }) };
      }
      const n = parsed.data.photo_number ?? convo.photos.length;
      const photo = convo.photos[n - 1];
      if (!photo) return { isError: true, content: JSON.stringify({ error: `There are only ${convo.photos.length} photos.` }) };

      const visual = providers.filter((p) => p.searchByImage && p.isConfigured());
      const limit = parsed.data.limit ?? 8;
      const { products: lists, reports } = await runProviders(visual, [], (p) => p.searchByImage!(photo, limit));
      const products = interleave(lists);
      remember(convo, products);
      const notes = reports.filter((r) => r.status === "error").map((r) => `${storeName(r.provider)} failed: ${r.error}`);
      return {
        content: JSON.stringify({
          photo_number: n,
          stores_searched: reports.filter((r) => r.status === "ok").map((r) => storeName(r.provider)),
          stores_failed: notes,
          products: products.map((p) => compactProduct(p)),
          same_product_at_several_stores: groupSameProduct(products).map((g) => ({
            title: g.title,
            offers: g.offers.map((o) => ({ id: o.id, store: o.store, price: money(o.price) })),
          })),
        }),
        ui: { type: "products", toolUseId, title: `Matches for photo ${n}`, products, notes },
      };
    }

    case "show_recommendations": {
      const parsed = RecommendInput.safeParse(input);
      if (!parsed.success) return invalid(parsed.error, input);
      const missing = parsed.data.picks.filter((p) => !convo.products.has(p.product_id)).map((p) => p.product_id);
      if (missing.length) {
        return {
          isError: true,
          content: JSON.stringify({ error: "Unknown product_id(s). Use ids from earlier tool results.", unknown: missing }),
        };
      }
      const picks = parsed.data.picks.map((p) => ({ label: p.label, reason: p.reason, product: convo.products.get(p.product_id)! }));
      return {
        content: JSON.stringify({ shown: picks.length }),
        ui: { type: "recommendations", title: parsed.data.title, picks },
      };
    }

    default:
      return { isError: true, content: JSON.stringify({ error: `Unknown tool ${name}` }) };
  }
}

function shortLink(u: string): string {
  try {
    const url = new URL(u);
    return url.hostname.replace(/^www\./, "") + (url.pathname.length > 30 ? url.pathname.slice(0, 30) + "…" : url.pathname);
  } catch {
    return u.slice(0, 40);
  }
}

/** One-line label for the "working…" indicator in the UI. */
export function toolLabel(name: string, input: any): string {
  switch (name) {
    case "search_products":
      return `Searching stores for “${input?.query ?? "…"}”${typeof input?.max_price === "number" ? ` under ${budget(input.max_price)}` : ""}`;
    case "read_product_links":
      return `Reading ${input?.urls?.length ?? ""} product link${input?.urls?.length === 1 ? "" : "s"}`;
    case "search_by_photo":
      return "Finding products that match your photo";
    case "show_recommendations":
      return "Preparing recommendations";
    default:
      return "Working";
  }
}
