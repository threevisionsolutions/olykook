import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { config } from "./config.js";
import { visionConfigured } from "./ai/describeImage.js";
import { providers } from "./providers/index.js";
import { searchByImage } from "./services/imageSearch.js";
import { resolveUrls } from "./services/resolveUrl.js";
import { searchAll } from "./services/search.js";
import type { SourceId } from "./types.js";

export const app = new Hono();
app.use("/api/*", cors());

const SOURCE_IDS = providers.map((p) => p.id) as [SourceId, ...SourceId[]];

const SearchParams = z.object({
  q: z.string().trim().min(1, "q is required").max(300),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  min_price: z.coerce.number().min(0).optional(),
  max_price: z.coerce.number().min(0).optional(),
  sort: z.enum(["relevance", "price_asc", "price_desc", "rating"]).optional(),
  sources: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined))
    .pipe(z.array(z.enum(SOURCE_IDS)).optional()),
});

const ResolveBody = z.object({ urls: z.array(z.string().min(4).max(2000)).min(1).max(10) });

const badRequest = (error: z.ZodError) => ({ error: error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ") });

app.get("/health", (c) => c.json({ ok: true }));

/** Which stores are connected, and how to connect the rest. */
app.get("/api/providers", (c) =>
  c.json({
    providers: providers.map((p) => ({ id: p.id, name: p.name, configured: p.isConfigured(), imageSearch: Boolean(p.searchByImage), setup: p.setup })),
    imageDescription: { configured: visionConfigured(), setup: "Set ANTHROPIC_API_KEY to enable photo → search on every store." },
  }),
);

/** GET /api/search?q=wireless earbuds&max_price=100&sort=price_asc&sources=amazon,ebay */
app.get("/api/search", async (c) => {
  const parsed = SearchParams.safeParse(c.req.query());
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  const { q, limit, min_price, max_price, sort, sources } = parsed.data;
  const result = await searchAll({ query: q, limit, minPrice: min_price, maxPrice: max_price, sort }, { sources });
  return c.json(result);
});

/** POST /api/resolve  { "urls": ["https://www.amazon.com/dp/B0…", "https://www.ebay.com/itm/…"] } */
app.post("/api/resolve", async (c) => {
  const parsed = ResolveBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(badRequest(parsed.error), 400);
  return c.json({ results: await resolveUrls(parsed.data.urls) });
});

/**
 * POST /api/search/image
 *   multipart/form-data: image=<file>, hint?, image_url?, limit?
 *   or JSON: { image_base64, mime_type, hint?, image_url?, limit? }
 */
app.post("/api/search/image", bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: "Image too large (max 5 MB)" }, 413) }), async (c) => {
  let base64: string | undefined;
  let mimeType: string | undefined;
  let hint: string | undefined;
  let imageUrl: string | undefined;
  let limit: number | undefined;

  if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const form = await c.req.parseBody();
    const file = form.image;
    if (file instanceof File) {
      base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
      mimeType = file.type;
    }
    hint = typeof form.hint === "string" ? form.hint : undefined;
    imageUrl = typeof form.image_url === "string" ? form.image_url : undefined;
    limit = Number(form.limit) || undefined;
  } else {
    const body = await c.req.json().catch(() => ({}));
    base64 = body.image_base64?.replace(/^data:[^;]+;base64,/, "");
    mimeType = body.mime_type;
    hint = body.hint;
    imageUrl = body.image_url;
    limit = Number(body.limit) || undefined;
  }

  if (!base64 || !mimeType) return c.json({ error: "Send an image file (field 'image') or image_base64 + mime_type" }, 400);
  if (Buffer.byteLength(base64, "base64") > 5 * 1024 * 1024) return c.json({ error: "Image too large (max 5 MB)" }, 413);

  const result = await searchByImage({ base64, mimeType, url: imageUrl }, { hint: hint?.slice(0, 200), limit: Math.min(limit ?? 10, 30) });
  return c.json(result);
});

const playground = () => readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
app.get("/", (c) => c.html(playground()));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const configured = providers.filter((p) => p.isConfigured()).map((p) => p.name);
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`Product discovery API on http://localhost:${info.port}`);
    console.log(configured.length ? `Connected stores: ${configured.join(", ")}` : "No store APIs configured yet. Copy .env.example to .env and add keys.");
    console.log("Pasted links work without any keys (read from the product page).");
  });
}
