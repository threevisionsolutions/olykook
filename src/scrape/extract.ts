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
import { asinFromUrl } from "../providers/amazon.js";
import type { Money, Product, SourceId } from "../types.js";

/** The store showed a bot check instead of the page. */
export class BlockedPageError extends Error {}
/** The page loaded but isn't a single product (category page, removed item, home page…). */
export class NotAProductError extends Error {}

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

/** Read the JSON object literal that starts at `start` (balanced braces, string-aware). */
function readJsonObject(src: string, start: number): unknown {
  let depth = 0;
  let inString = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(src.slice(start, i + 1));
  }
  return undefined;
}

/**
 * Shopify stores (millions of them) always include product analytics data,
 * `var meta = {"product":{"vendor":…,"variants":[{"id":…,"price":15900}]}}`, with prices in cents.
 * Used when a store doesn't publish standard product data.
 */
function fromShopify(html: string, pageUrl: URL): Partial<Product> {
  const at = html.indexOf('var meta = {"product"');
  if (at < 0) return {};
  try {
    const meta = readJsonObject(html, html.indexOf("{", at)) as any;
    const product = meta?.product;
    const variants: any[] = product?.variants ?? [];
    if (!variants.length) return {};
    const wanted = pageUrl.searchParams.get("variant");
    const variant = variants.find((v) => String(v.id) === wanted) ?? variants.reduce((a, b) => (b.price < a.price ? b : a));
    const currency =
      html.match(/Shopify\.currency\s*=\s*\{"active":"([A-Z]{3})"/)?.[1] ??
      html.match(/ShopifyAnalytics\.meta\.currency\s*=\s*'([A-Z]{3})'/)?.[1] ??
      "USD";
    return compact({
      price: typeof variant.price === "number" ? { amount: variant.price / 100, currency } : undefined,
      brand: product.vendor,
      identifiers: compact({ sku: variant.sku || undefined }),
      specs: variants.length > 1 ? { Options: `${variants.length} variants (price shown: ${variant.public_title ?? variant.name ?? "cheapest"})` } : undefined,
    });
  } catch {
    return {};
  }
}

/** Visible text of an element, ignoring any <script>/<style> inside it. */
function cleanText($: CheerioAPI, selector: string): string {
  const el = $(selector).first().clone();
  el.find("script, style, noscript").remove();
  return el.text().replace(/\s+/g, " ").trim();
}

/** Amazon moves its price around between page layouts; take the first one that parses. */
const AMAZON_PRICE_SELECTORS = [
  "#corePrice_feature_div .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-offscreen",
  "#apex_offerDisplay_desktop .a-offscreen",
  "#corePrice_desktop .a-offscreen",
  ".apex-pricetopay-value .a-offscreen",
  ".priceToPay .aok-offscreen",
  ".priceToPay .a-offscreen",
  "#priceblock_ourprice",
  "#priceblock_dealprice",
];

/** Amazon doesn't publish JSON-LD, so read its page elements directly. */
function fromAmazon($: CheerioAPI): Partial<Product> {
  const priceText =
    AMAZON_PRICE_SELECTORS.map((sel) => $(sel).first().text().trim()).find((t) => parsePrice(t) !== undefined) ?? "";
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
    availability: cleanText($, "#availability").replace(/\.\s.*$/, "") || undefined,
    features: $("#feature-bullets li span.a-list-item")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean),
    specs: Object.keys(specs).length ? specs : undefined,
  });
}

export function looksBlocked($: CheerioAPI, html: string, pageUrl: URL): boolean {
  // Stores often redirect blocked visitors to a dedicated page.
  if (/\/(blocked|captcha|punish)\b|_____tmd_____/i.test(pageUrl.pathname)) return true;
  if ($('form[action*="validateCaptcha"]').length) return true;
  if (/captcha|robot check|robot or human|access denied|are you a human|unusual traffic|just a moment|attention required/i.test($("title").text())) return true;
  // Amazon's "Click the button below to continue shopping" wall and AliExpress's slider captcha.
  if (/To discuss automated access to Amazon data|_____tmd_____\/punish|"action":"captcha"/.test(html)) return true;
  return html.length < 20_000 && /px-captcha|cf-chl|verify you are human/i.test(html);
}

/** Does the page describe one product, rather than a category, search or home page? */
function isProductPage($: CheerioAPI, jsonLd: unknown, amazon: Partial<Product>): boolean {
  if (jsonLd || amazon.title) return true;
  const ogType = ($('meta[property="og:type"]').attr("content") ?? "").toLowerCase();
  if (ogType === "product" || ogType === "og:product" || ogType === "product.item") return true;
  return Boolean($('meta[property="product:price:amount"], meta[property="og:price:amount"], [itemprop="price"]').length);
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** Some stores HTML-escape text inside their JSON data, e.g. `5&quot; Shorts`. */
export function decodeEntities(s: string | undefined): string | undefined {
  if (!s) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, n) => ENTITIES[n])
    .trim();
}

/** Merge: earlier sources win, later ones only fill gaps. */
function merge(...parts: Partial<Product>[]): Partial<Product> {
  const out: any = {};
  for (const p of parts) for (const [k, v] of Object.entries(p)) if (out[k] === undefined && v !== undefined) out[k] = v;
  return out;
}

export function extractProduct(html: string, pageUrl: URL): Product {
  const $ = cheerio.load(html);
  if (looksBlocked($, html, pageUrl)) throw new BlockedPageError(`${pageUrl.hostname} showed a bot check instead of the product page`);

  const { source, store } = storeForHost(pageUrl.hostname);
  const jsonLd = findJsonLdProduct($);
  const amazon = source === "amazon" ? fromAmazon($) : {};
  if (!isProductPage($, jsonLd, amazon)) {
    throw new NotAProductError("That link doesn't open a single product page (it may have been removed, or it's a category page)");
  }
  const merged = merge(amazon, jsonLd ? fromJsonLd(jsonLd) : {}, fromMeta($), fromShopify(html, pageUrl));
  if (!merged.title) throw new NotAProductError("Couldn't find product details on that page");

  const abs = (u?: string) => (u ? new URL(u, pageUrl).href : undefined);
  // Amazon: the product code (ASIN) is the stable id, and /dp/ASIN is the clean link.
  // Its canonical tag can point at odd pages (/clp/…) or a different model, so ignore it.
  const asin = source === "amazon" ? asinFromUrl(pageUrl) : undefined;
  const canonical = abs($('link[rel="canonical"]').attr("href"));
  const url = asin
    ? `https://${pageUrl.hostname}/dp/${asin}`
    : canonical && new URL(canonical).hostname === pageUrl.hostname
      ? canonical
      : pageUrl.href;
  const sourceId = asin ?? url;

  return compact({
    ...merged,
    identifiers: asin ? { ...merged.identifiers, asin } : merged.identifiers,
    id: `${source}:${sourceId}`,
    source,
    sourceId,
    store,
    title: decodeEntities(merged.title),
    brand: decodeEntities(merged.brand),
    features: merged.features?.map((f) => decodeEntities(f)!),
    url,
    imageUrl: abs(merged.imageUrl),
    images: merged.images?.map((i) => abs(i)!).filter(Boolean),
    description: decodeEntities(merged.description)?.slice(0, 1500),
    via: "page",
  } as Product);
}
