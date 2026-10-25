import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChatTurn, setChatClient, type ChatEvent } from "../src/chat/agent.js";
import { createConversation } from "../src/chat/store.js";
import { TOOL_DEFINITIONS } from "../src/chat/tools.js";
import { app } from "../src/server.js";
import { streamFor, type ScriptedReply } from "./fakeClaude.js";
import { clearEnv, mockFetch, setEnv, type Recorded } from "./helpers.js";

const BESTBUY_HEADPHONES = {
  products: [
    { sku: 6505727, name: "Sony WH-1000XM5", salePrice: 329.99, regularPrice: 399.99, customerReviewAverage: 4.7, customerReviewCount: 3021, url: "https://www.bestbuy.com/site/6505727.p" },
    { sku: 6501234, name: "Bose QuietComfort", salePrice: 249, customerReviewAverage: 4.6, customerReviewCount: 1800, url: "https://www.bestbuy.com/site/6501234.p" },
  ],
};

/** Route Claude calls to a script, store calls to fixtures; returns the log of Claude requests. */
function setup(script: ScriptedReply[], extraRoutes: Parameters<typeof mockFetch>[0] = []) {
  let n = 0;
  const log = mockFetch([
    [/api\.anthropic\.com\/v1\/messages/, () => {
      const reply = script[n++];
      if (!reply) throw new Error("Claude script ran out of replies");
      if (reply.status) return { status: reply.status, json: { type: "error", error: { type: "api_error", message: "boom" } } };
      return { text: streamFor(reply, n), headers: { "content-type": "text/event-stream" } };
    }],
    [/api\.bestbuy\.com/, () => ({ json: BESTBUY_HEADPHONES })],
    ...extraRoutes,
  ]);
  // Built after mocking fetch so the SDK picks up the mock. No retries: tests should be fast.
  setChatClient(new Anthropic({ apiKey: "test-key", baseURL: "https://api.anthropic.com", maxRetries: 0 }));
  return { claudeCalls: () => log.filter((r) => r.url.includes("anthropic")), log };
}

const body = (r: Recorded) => JSON.parse(r.body!);

beforeEach(() => {
  clearEnv();
  setEnv({ BESTBUY_API_KEY: "bb", ANTHROPIC_API_KEY: "test-key" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  setChatClient(undefined);
});

describe("chat turn", () => {
  it("searches, recommends, and answers, streaming events along the way", async () => {
    const { claudeCalls } = setup([
      { blocks: [
        { type: "thinking", thinking: "", signature: "sig-1" },
        { type: "tool_use", id: "toolu_1", name: "search_products", input: { query: "noise cancelling headphones", max_price: 350 } },
      ] },
      { blocks: [
        { type: "tool_use", id: "toolu_2", name: "show_recommendations", input: {
          title: "Top picks under $350",
          picks: [
            { product_id: "bestbuy:6505727", label: "Best overall", reason: "Top-rated with 3,000+ reviews." },
            { product_id: "bestbuy:6501234", label: "Best value", reason: "$80 less, nearly the same rating." },
          ],
        } },
      ] },
      { blocks: [{ type: "text", text: "The **Sony WH-1000XM5** is my pick." }] },
    ]);

    const convo = createConversation();
    const events: ChatEvent[] = [];
    await runChatTurn(convo, { text: "Best noise cancelling headphones under $350?" }, (e) => void events.push(e));

    expect(events.map((e) => e.type)).toEqual([
      "tool_start", "products", "tool_end",
      "tool_start", "recommendations", "tool_end",
      "text", "text", "done",
    ]);
    const products = events.find((e) => e.type === "products") as Extract<ChatEvent, { type: "products" }>;
    expect(products.products.map((p) => p.id)).toEqual(["bestbuy:6505727", "bestbuy:6501234"]);
    const recs = events.find((e) => e.type === "recommendations") as Extract<ChatEvent, { type: "recommendations" }>;
    expect(recs.picks.map((p) => [p.label, p.product.title])).toEqual([["Best overall", "Sony WH-1000XM5"], ["Best value", "Bose QuietComfort"]]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as any).text).join("")).toBe("The **Sony WH-1000XM5** is my pick.");

    // Request shape: model, tools, fallbacks, caching, effort.
    const first = body(claudeCalls()[0]);
    expect(first).toMatchObject({
      model: "claude-opus-5-5",
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "medium" },
      tool_choice: { type: "auto" },
      stream: true,
    });
    expect(first.thinking).toBeUndefined();
    expect(first.tools.map((t: any) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
    expect(claudeCalls()[0].headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");

    // Tool results go back in one user message, and Claude's turn (with its thinking block) is kept verbatim.
    const second = body(claudeCalls()[1]);
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "sig-1" });
    expect(second.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    const toolResult = JSON.parse(second.messages[2].content[0].content);
    expect(toolResult.products[0]).toMatchObject({ id: "bestbuy:6505727", price: "329.99 USD", rating: 4.7 });

    expect(convo.messages).toHaveLength(6);
  });

  it("keeps history append-only across turns (same system, tools and earlier messages)", async () => {
    const { claudeCalls } = setup([
      { blocks: [{ type: "thinking", thinking: "", signature: "s1" }, { type: "text", text: "What's your budget?" }] },
      { blocks: [{ type: "text", text: "Got it." }] },
    ]);
    const convo = createConversation();
    await runChatTurn(convo, { text: "I need headphones" }, () => {});
    await runChatTurn(convo, { text: "Under $100" }, () => {});
    const [a, b] = claudeCalls().map(body);
    expect(b.system).toEqual(a.system);
    expect(b.tools).toEqual(a.tools);
    expect(b.messages.slice(0, a.messages.length)).toEqual(a.messages);
    expect(b.messages[1].content[0]).toMatchObject({ type: "thinking", signature: "s1" });
    expect(b.messages).toHaveLength(3);
  });

  it("returns invalid tool input to Claude as an error instead of running the tool", async () => {
    const { claudeCalls } = setup([
      { blocks: [{ type: "tool_use", id: "toolu_bad", name: "search_products", input: { query: "", limit: 500 } }] },
      { blocks: [{ type: "text", text: "Let me fix that." }] },
    ]);
    const events: ChatEvent[] = [];
    await runChatTurn(createConversation(), { text: "hi" }, (e) => void events.push(e));
    const result = body(claudeCalls()[1]).messages[2].content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("INVALID_INPUT");
    expect(events.find((e) => e.type === "tool_end")).toMatchObject({ ok: false });
  });

  it("rejects recommendations for products that were never returned", async () => {
    const { claudeCalls } = setup([
      { blocks: [{ type: "tool_use", id: "t1", name: "show_recommendations", input: { title: "Picks", picks: [{ product_id: "amazon:FAKE", label: "Best", reason: "x" }] } }] },
      { blocks: [{ type: "text", text: "ok" }] },
    ]);
    await runChatTurn(createConversation(), { text: "hi" }, () => {});
    const result = body(claudeCalls()[1]).messages[2].content[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("amazon:FAKE");
  });

  it("rolls the conversation back when the AI service fails, so the chat can continue", async () => {
    setup([
      { blocks: [{ type: "tool_use", id: "t1", name: "search_products", input: { query: "kettle" } }] },
      { status: 500 },
    ]);
    const convo = createConversation();
    const events: ChatEvent[] = [];
    await runChatTurn(convo, { text: "kettle?", photos: [{ base64: "aGk=", mimeType: "image/png" }] }, (e) => void events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "error", message: "The AI service had a problem. Please try again." });
    expect(convo.messages).toHaveLength(0);
    expect(convo.photos).toHaveLength(0);
  });

  it("handles refusals with a polite message and no broken history", async () => {
    setup([{ blocks: [], stop_reason: "refusal" }]);
    const convo = createConversation();
    const events: ChatEvent[] = [];
    await runChatTurn(convo, { text: "something not allowed" }, (e) => void events.push(e));
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Sorry, I can't help with that request." });
    expect(convo.messages).toHaveLength(0);
  });

  it("forces a final answer after too many tool rounds", async () => {
    const search = (i: number): ScriptedReply => ({ blocks: [{ type: "tool_use", id: `t${i}`, name: "search_products", input: { query: `q${i}` } }] });
    const { claudeCalls } = setup([...Array.from({ length: 8 }, (_, i) => search(i)), { blocks: [{ type: "text", text: "Here's what I found." }] }]);
    const events: ChatEvent[] = [];
    await runChatTurn(createConversation(), { text: "find everything" }, (e) => void events.push(e));
    const calls = claudeCalls().map(body);
    expect(calls).toHaveLength(9);
    expect(calls[7].tool_choice).toEqual({ type: "auto" });
    expect(calls[8].tool_choice).toEqual({ type: "none" });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends uploaded photos to Claude and lets it run a visual search", async () => {
    setEnv({ SHOPIFY_CATALOG_DISABLED: undefined });
    const { claudeCalls } = setup(
      [
        { blocks: [{ type: "tool_use", id: "t1", name: "search_by_photo", input: {} }] },
        { blocks: [{ type: "text", text: "Found similar lamps." }] },
      ],
      [[/catalog\.shopify\.com/, () => ({ json: { jsonrpc: "2.0", id: 1, result: { structuredContent: { products: [{
        id: "gid://shopify/p/lamp", title: "Brass Desk Lamp",
        variants: [{ url: "https://lamps.example/products/brass", price: { amount: 8900, currency: "USD" }, seller: { name: "Lamp Co", url: "https://lamps.example" } }],
      }] } } } })]],
    );
    const convo = createConversation();
    const events: ChatEvent[] = [];
    await runChatTurn(convo, { text: "find this", photos: [{ base64: "cGhvdG8=", mimeType: "image/jpeg" }] }, (e) => void events.push(e));

    const first = body(claudeCalls()[0]).messages[0].content;
    expect(first[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "cGhvdG8=" } });
    expect(first[1].text).toBe("[Shopper uploaded photo 1]\nfind this");
    const products = events.find((e) => e.type === "products") as Extract<ChatEvent, { type: "products" }>;
    expect(products.products[0]).toMatchObject({ title: "Brass Desk Lamp", store: "Lamp Co", price: { amount: 89 } });
  });
});

describe("POST /api/chat", () => {
  const post = (data: unknown) => app.request("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

  it("explains how to turn chat on when there's no Anthropic key", async () => {
    setEnv({ ANTHROPIC_API_KEY: undefined });
    const res = await post({ message: "hi" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("validates input and reports expired chats", async () => {
    expect((await post({ message: "" })).status).toBe(400);
    expect((await post({ message: "hi", photos: [{ base64: "x".repeat(20), mime_type: "image/heic" }] })).status).toBe(400);
    const expired = await post({ message: "hi", conversation_id: "00000000-0000-4000-8000-000000000000" });
    expect(expired.status).toBe(404);
    expect((await expired.json()).code).toBe("expired");
  });

  it("streams a full turn as Server-Sent Events and continues the same conversation", async () => {
    setup([
      { blocks: [{ type: "text", text: "Hello! What are you looking for?" }] },
      { blocks: [{ type: "text", text: "Sure." }] },
    ]);
    const parse = async (res: Response) =>
      (await res.text())
        .split("\n\n")
        .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
        .filter(Boolean)
        .map((l) => JSON.parse(l!.slice(5)));

    const res = await post({ message: "hi" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = await parse(res);
    expect(events[0].type).toBe("conversation");
    expect(events.filter((e) => e.type === "text").map((e) => e.text).join("")).toBe("Hello! What are you looking for?");
    expect(events.at(-1).type).toBe("done");

    const again = await parse(await post({ message: "headphones", conversation_id: events[0].id }));
    expect(again[0].id).toBe(events[0].id);
    expect(again.at(-1).type).toBe("done");
  });
});
