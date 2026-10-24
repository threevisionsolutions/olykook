import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearEnv, mockFetch, setEnv } from "./helpers.js";

beforeEach(clearEnv);
afterEach(() => vi.unstubAllGlobals());

const description = {
  is_product: true,
  product_type: "wireless headphones",
  brand: "Sony",
  model: "WH-1000XM5",
  attributes: ["black", "over-ear"],
  search_query: "Sony WH-1000XM5 black",
  alternative_queries: ["over-ear noise cancelling headphones"],
};

const claudeReply = () => ({
  json: {
    id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
    content: [{ type: "text", text: JSON.stringify(description) }],
    usage: { input_tokens: 1500, output_tokens: 80 },
  },
});

describe("photo search with Claude", () => {
  it("asks Claude for a structured description, then searches the stores with it", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-test", BESTBUY_API_KEY: "bb" });
    const log = mockFetch([
      [/api\.anthropic\.com\/v1\/messages/, claudeReply],
      [/api\.bestbuy\.com/, () => ({ json: { products: [{ sku: 6505727, name: "Sony WH-1000XM5", salePrice: 329.99, upc: "027242923232" }] } })],
    ]);
    const { searchByImage } = await import("../src/services/imageSearch.js");

    const result = await searchByImage({ base64: "aGVsbG8=", mimeType: "image/jpeg" }, { limit: 5 });

    const claude = log.find((r) => r.url.includes("anthropic"))!;
    const body = JSON.parse(claude.body!);
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.fallbacks).toBe("default");
    expect(claude.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.messages[0].content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" } });

    expect(result.description?.model).toBe("WH-1000XM5");
    expect(result.query).toBe("Sony WH-1000XM5 black");
    const bestbuyReq = log.find((r) => r.url.includes("bestbuy"))!;
    expect(decodeURIComponent(bestbuyReq.url)).toContain("search=Sony&search=WH-1000XM5&search=black");
    expect(result.products[0].title).toBe("Sony WH-1000XM5");
  });

  it("rejects image types Claude can't read", async () => {
    setEnv({ ANTHROPIC_API_KEY: "sk-test" });
    const { describeProductImage } = await import("../src/ai/describeImage.js");
    await expect(describeProductImage({ base64: "x", mimeType: "image/heic" })).rejects.toThrow(/Unsupported image type/);
  });
});
