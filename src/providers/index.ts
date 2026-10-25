import type { Provider, SourceId } from "../types.js";
import { aliexpress } from "./aliexpress.js";
import { amazon } from "./amazon.js";
import { bestbuy } from "./bestbuy.js";
import { ebay } from "./ebay.js";
import { etsy } from "./etsy.js";
import { googleShopping } from "./serpapi.js";
import { shopify } from "./shopify.js";
import { walmart } from "./walmart.js";

/**
 * Every store we can search. Add a new store by writing a Provider and listing it here.
 * Order matters for pasted links: the first provider whose matchesUrl() accepts a link handles it,
 * so the catch-all Shopify matcher (any /products/ link) comes after the store-specific ones.
 */
export const providers: Provider[] = [amazon, ebay, walmart, aliexpress, bestbuy, etsy, shopify, googleShopping];

export const providerById = (id: SourceId) => providers.find((p) => p.id === id);

export const configuredProviders = () => providers.filter((p) => p.isConfigured());
