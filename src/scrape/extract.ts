/**
 * Turns a product page's HTML into a Product.
 *
 * Most stores embed machine-readable product data for Google (schema.org JSON-LD,
 * microdata, OpenGraph tags), so we read that first. That works on Shopify,
 * WooCommerce, Target, Home Depot, Alibaba, Newegg and most other stores without
 * per-site code. Amazon needs a few page selectors because it doesn't publish JSON-LD.
 */
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { compact, guessCurrency, parsePrice, toNumber } from "../lib/http.js";
import type { Money, Product, SourceId } from "../types.js";

export class BlockedPageError extends Error {}

const STORE_NAMES: [RegExp, SourceId, string][] = [
  [/(^|\.)amazon\./, "amazon", "Amazon"],
  [/(^|\.)ebay\./, "ebay", "eBay"],
  [/(^|\.)aliexpress\./, "aliexpress", "AliExpress"],
  [/(^|\.)alibaba\.com$/, "web", "Alibaba"],
  [/(^|\.)walmart\.com$/, "walmart", "Walmart"],
  [/(^|\.)bestbuy\.com$/, "bestbuy", "Best Buy"],
  [/(^|\.)etsy\.com$/, "etsy", "Etsy"],
];

export function storeForHost(hostname: string): { source: SourceId; store: string } {
  for (const [re, source, store] of STORE_NAMES) if (re.test(hostname)) return { source, store };
  const bare = hostname.replace(/^www\./, "");
  return { source: "web", store: bare };
}

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);
const typeIs = (node: any, t: string) => asArray(node?.["@type"]).some((x) => String(x).toLowerCase() === t.toLowerCase());
const text = (v: any): string | undefined => {
  if (v == null) return undefined;
  if (typeof v === "string" || typeof v === "number") return String(v).trim() || undefined;
  if (Array.isArray(v)) return text(v[0]);
  return text(v.name ?? v["@value"] ?? v.url);
};

/** Find the Product node in every JSON-LD block (handles @graph, arrays, ProductGroup). */
export function findJsonLdProduct($: CheerioAPI): any | undefined {
  const nodes: any[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      const walk = (n: any) => {
        for (const item of asArray(n)) {
          if (!item || typeof item !== "object") continue;
          nodes.push(item);
          if (item["@graph"]) walk(item["@graph"]);
          if (item.mainEntity) walk(item.mainEntity);
        }
      };
      // Some sites put raw newlines inside strings, which JSON.parse rejects.
      walk(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, " ")));
    } catch {
      /* ignore malformed blocks */
    }
  });
  const product = nodes.find((n) => typeIs(n, "Product")) ?? nodes.find((n) => typeIs(n, "ProductGroup"));
  if (product && typeIs(product, "ProductGroup") && product.hasVariant) {
    const first = asArray(product.hasVariant)[0];
    return { ...first, ...product, offers: product.offers ?? first?.offers };
  }
  return product;
}

function offerPrice(offers: any): { price?: Money; availability?: string; seller?: string; condition?: string } {
  const list = asArray(offers).flatMap((o: any) => (typeIs(o, "AggregateOffer") && o.offers ? asArray(o.offers) : [o]));
  const o = list.find((x: any) => x?.price ?? x?.lowPrice ?? x?.priceSpecification) ?? list[0];
  if (!o) return {};
  const spec = asArray(o.priceSpecification)[0];
  const amount = parsePrice(o.price ?? o.lowPrice ?? spec?.price);
  const currency = o.priceCurrency ?? spec?.priceCurrency;
  return {
    price: amount !== undefined ? { amount, currency: currency ?? guessCurrency(String(o.price ?? "")) } : undefined,
    availability: text(o.availability)?.replace(/^https?:\/\/schema\.org\//, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
    seller: text(o.seller),
    condition: text(o.itemCondition)?.replace(/^https?:\/\/schema\.org\//, "").replace(/Condition$/, ""),
  };
}

function fromJsonLd(node: any): Partial<Product> {
  const offer = offerPrice(node.offers);
  const images = asArray(node.image).map((i: any) => (typeof i === "string" ? i : i?.url ?? i?.contentUrl)).filter(Boolean);
  const specs: Record<string, string> = {};
  for (const p of asArray(node.additionalProperty)) {
    const name = text((p as any)?.name);
    const value = text((p as any)?.value);
    if (name && value) specs[name] = value;
  }
  return compact({
    title: text(node.name),
    description: text(node.description),
    imageUrl: images[0],
    images,
    brand: text(node.brand),
    rating: toNumber(node.aggregateRating?.ratingValue),
    reviewCount: toNumber(node.aggregateRating?.reviewCount ?? node.aggregateRating?.ratingCount),
    specs: Object.keys(specs).length ? specs : undefined,
    identifiers: compact({
      gtin: text(node.gtin ?? node.gtin13 ?? node.gtin14 ?? node.gtin12 ?? node.gtin8),
      mpn: text(node.mpn),
      sku: text(node.sku),
      model: text(node.model),
    }),
    ...offer,
  });
}

function fromMeta($: CheerioAPI): Partial<Product> {
  const meta = (k: string) =>
    $(`meta[property="${k}"]`).attr("content")?.trim() || $(`meta[name="${k}"]`).attr("content")?.trim() || undefined;
  const amount = parsePrice(meta("product:price:amount") ?? meta("og:price:amount") ?? $('[itemprop="price"]').attr("content"));
  const currency = meta("product:price:currency") ?? meta("og:price:currency") ?? $('[itemprop="priceCurrency"]').attr("content");
  return compact({
    title: meta("og:title") ?? meta("twitter:title") ?? ($("title").first().text().trim() || undefined),
    description: meta("og:description") ?? meta("description"),
    imageUrl: meta("og:image") ?? meta("twitter:image"),
    brand: meta("product:brand") ?? $('[itemprop="brand"]').first().text().trim(),
    price: amount !== undefined ? { amount, currency: currency ?? "USD" } : undefined,
  });
}

/** Amazon doesn't publish JSON-LD, so read its page elements directly. */
function fromAmazon($: CheerioAPI): Partial<Product> {
  const priceText =
    $("#corePrice_feature_div .a-offscreen").first().text() ||
    $("#corePriceDisplay_desktop_feature_div .a-offscreen").first().text() ||
    $(".priceToPay .a-offscreen").first().text() ||
    $("#priceblock_ourprice, #priceblock_dealprice").first().text();
  const listText = $(".basisPrice .a-offscreen").first().text();
  const img = $("#landingImage").attr("data-old-hires") || $("#landingImage").attr("src") || $("#imgBlkFront").attr("src");
  const ratingText = $("#acrPopover").attr("title") || $('[data-hook="rating-out-of-text"]').text();
  const countText = $("#acrCustomerReviewText").first().text();
  const specs: Record<string, string> = {};
  $("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #productOverview_feature_div tr").each((_, tr) => {
    const k = $(tr).find("th, td").first().text().replace(/\s+/g, " ").trim();
    const v = $(tr).find("td").last().text().replace(/[‎‏]/g, "").replace(/\s+/g, " ").trim();
    if (k && v && k !== v) specs[k] = v;
  });
  const amount = parsePrice(priceText);
  const list = parsePrice(listText);
  return compact({
    title: $("#productTitle").text().trim(),
    price: amount !== undefined ? { amount, currency: guessCurrency(priceText) } : undefined,
    originalPrice: list !== undefined && amount !== undefined && list > amount ? { amount: list, currency: guessCurrency(listText) } : undefined,
    imageUrl: img,
    rating: parsePrice(ratingText),
    reviewCount: parsePrice(countText),
    brand: $("#bylineInfo").text().replace(/^(Visit the|Brand:)\s*/i, "").replace(/\s*Store$/i, "").trim(),
    availability: $("#availability").text().replace(/\s+/g, " ").trim(),
    features: $("#feature-bullets li span.a-list-item")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean),
    specs: Object.keys(specs).length ? specs : undefined,
  });
}

function looksBlocked($: CheerioAPI, html: string): boolean {
  if ($('form[action*="validateCaptcha"]').length) return true;
  if (/captcha|robot check|access denied|are you a human|unusual traffic|px-captcha|cf-chl/i.test($("title").text())) return true;
  return html.length < 1500 && /captcha|verify you are human/i.test(html);
}

/** Merge: earlier sources win, later ones only fill gaps. */
function merge(...parts: Partial<Product>[]): Partial<Product> {
  const out: any = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) if (out[k] === undefined && v !== undefined) out[k] = v;
  return out;
}

export function extractProduct(html: string, pageUrl: URL): Product {
  const $ = cheerio.load(html);
  if (looksBlocked($, html)) throw new BlockedPageError(`${pageUrl.hostname} showed a bot check instead of the product page`);

  const { source, store } = storeForHost(pageUrl.hostname);
  const jsonLd = findJsonLdProduct($);
  const merged = merge(
    source === "amazon" ? fromAmazon($) : {},
    jsonLd ? fromJsonLd(jsonLd) : {},
    fromMeta($),
  );

  if (!merged.title) throw new Error("Couldn't find product details on that page");
  const abs = (u?: string) => (u ? new URL(u, pageUrl).href : undefined);
  const canonical = $('link[rel="canonical"]').attr("href");
  const url = abs(canonical) ?? pageUrl.href;

  return compact({
    ...merged,
    id: `${source}:${url}`,
    source,
    sourceId: url,
    store,
    title: merged.title,
    url,
    imageUrl: abs(merged.imageUrl),
    images: merged.images?.map((i) => abs(i)!).filter(Boolean),
    description: merged.description?.slice(0, 1500),
    via: "page",
  } as Product);
}
