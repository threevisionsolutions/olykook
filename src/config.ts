import { readFileSync } from "node:fs";

/**
 * All settings come from environment variables (see .env.example).
 * Read lazily so tests can change process.env between cases.
 */
const env = (name: string, fallback = ""): string => process.env[name]?.trim() || fallback;

export const config = {
  get port() {
    return Number(env("PORT", "3000"));
  },
  get country() {
    return env("DEFAULT_COUNTRY", "US");
  },
  get currency() {
    return env("DEFAULT_CURRENCY", "USD");
  },

  ebay: {
    get clientId() { return env("EBAY_CLIENT_ID"); },
    get clientSecret() { return env("EBAY_CLIENT_SECRET"); },
    get marketplaceId() { return env("EBAY_MARKETPLACE_ID", "EBAY_US"); },
    /** eBay Partner Network campaign id; turns item links into affiliate links. */
    get campaignId() { return env("EBAY_CAMPAIGN_ID"); },
    get sandbox() { return env("EBAY_ENV") === "sandbox"; },
  },

  amazon: {
    get credentialId() { return env("AMAZON_CREDENTIAL_ID"); },
    get credentialSecret() { return env("AMAZON_CREDENTIAL_SECRET"); },
    /** 3.1 = North America, 3.2 = Europe, 3.3 = Far East (2.x = older Cognito credentials). */
    get credentialVersion() { return env("AMAZON_CREDENTIAL_VERSION", "3.1"); },
    get partnerTag() { return env("AMAZON_PARTNER_TAG"); },
    get marketplace() { return env("AMAZON_MARKETPLACE", "www.amazon.com"); },
  },

  aliexpress: {
    get appKey() { return env("ALIEXPRESS_APP_KEY"); },
    get appSecret() { return env("ALIEXPRESS_APP_SECRET"); },
    get trackingId() { return env("ALIEXPRESS_TRACKING_ID"); },
    get language() { return env("ALIEXPRESS_LANGUAGE", "EN"); },
  },

  walmart: {
    get consumerId() { return env("WALMART_CONSUMER_ID"); },
    get keyVersion() { return env("WALMART_KEY_VERSION", "1"); },
    get publisherId() { return env("WALMART_PUBLISHER_ID"); },
    /** PEM contents, or WALMART_PRIVATE_KEY_PATH pointing at the .pem file. */
    get privateKey(): string {
      const inline = env("WALMART_PRIVATE_KEY").replace(/\\n/g, "\n");
      if (inline) return inline;
      const path = env("WALMART_PRIVATE_KEY_PATH");
      if (!path) return "";
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
  },

  bestbuy: {
    get apiKey() { return env("BESTBUY_API_KEY"); },
  },

  etsy: {
    get apiKey() { return env("ETSY_API_KEY"); },
    get sharedSecret() { return env("ETSY_SHARED_SECRET"); },
  },

  serpapi: {
    get apiKey() { return env("SERPAPI_API_KEY"); },
  },

  shopify: {
    /** Optional. A free Dev Dashboard "Catalogs" API key raises the rate limit to 5 searches/second. */
    get clientId() { return env("SHOPIFY_CATALOG_CLIENT_ID"); },
    get clientSecret() { return env("SHOPIFY_CATALOG_CLIENT_SECRET"); },
    /** Public URL of your agent profile. Defaults to Shopify's example profile, fine for development. */
    get profileUrl() {
      return env("SHOPIFY_AGENT_PROFILE_URL", "https://shopify.dev/ucp/agent-profiles/examples/2026-08-25/valid-with-capabilities.json");
    },
    get disabled() { return env("SHOPIFY_CATALOG_DISABLED") === "true"; },
  },

  anthropic: {
    get apiKey() { return env("ANTHROPIC_API_KEY"); },
  },
};
