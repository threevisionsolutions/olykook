/**
 * Uses Claude's vision to turn a product photo into a search query, so photo
 * search works on every store, not just eBay (the only store API with image search).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { config } from "../config.js";
import type { ImageInput } from "../types.js";

export const ImageDescription = z.object({
  is_product: z.boolean().describe("False if the photo doesn't show a product someone could buy"),
  product_type: z.string().describe("Generic product category, e.g. 'running shoes'"),
  brand: z.string().nullable().describe("Brand if visible or confidently recognizable, else null"),
  model: z.string().nullable().describe("Model name/number if identifiable, else null"),
  attributes: z.array(z.string()).describe("Visible attributes that matter when shopping: color, material, style, size cues"),
  search_query: z.string().describe("Best 3-8 word query to find this exact item (or the closest match) on Amazon/eBay"),
  alternative_queries: z.array(z.string()).describe("1-3 broader queries for similar items"),
});
export type ImageDescription = z.infer<typeof ImageDescription>;

const SUPPORTED = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

let client: Anthropic | undefined;

export const visionConfigured = () => Boolean(config.anthropic.apiKey);

export async function describeProductImage(image: ImageInput, hint?: string): Promise<ImageDescription> {
  if (!SUPPORTED.has(image.mimeType)) throw new Error(`Unsupported image type ${image.mimeType}; use JPEG, PNG, GIF or WebP`);
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });

  const response = await client.beta.messages.parse({
    model: "claude-opus-5-5",
    max_tokens: 2000,
    output_config: { effort: "low", format: betaZodOutputFormat(ImageDescription) },
    // If the main model declines, Anthropic retries on a recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system:
      "You identify products in shoppers' photos so we can search online stores for them. " +
      "Be specific when the brand or model is clearly identifiable, and generic when it isn't. Never invent model numbers.",
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mimeType as "image/jpeg", data: image.base64 } },
          { type: "text", text: hint ? `The shopper added: "${hint}". Identify the product.` : "Identify the product in this photo." },
        ],
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("The image couldn't be analyzed");
  if (!response.parsed_output) throw new Error("Couldn't read the image analysis");
  return response.parsed_output;
}
