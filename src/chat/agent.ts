/**
 * Runs one chat turn: sends the conversation to Claude, streams the reply, runs any tools
 * Claude asks for, and repeats until Claude has answered.
 *
 * History rules (Claude Opus 5.5 checks them): the system prompt and tool list never change,
 * earlier messages are never edited, and Claude's replies are stored exactly as returned
 * (including thinking blocks). If a turn fails, the conversation is rolled back to how it
 * was before the turn, which keeps it valid.
 */
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { ImageInput } from "../types.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { Conversation } from "./store.js";
import { runTool, TOOL_DEFINITIONS, toolLabel, type UiEvent } from "./tools.js";

export const CHAT_MODEL = "claude-opus-5-5";
/** Tool rounds per turn before Claude must answer with what it has. */
const MAX_TOOL_ROUNDS = 8;

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; ok: boolean }
  | UiEvent
  | { type: "done" }
  | { type: "error"; message: string };

let client: Anthropic | undefined;
export const chatConfigured = () => Boolean(config.anthropic.apiKey);

/** Tests inject a client pointed at a fake API. */
export function setChatClient(c: Anthropic | undefined) {
  client = c;
}

function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey });
  return client;
}

export interface UserTurn {
  text: string;
  photos?: ImageInput[];
}

/** Build the user message: photos first (numbered so tools can refer to them), then the text. */
export function buildUserContent(convo: Conversation, turn: UserTurn): Anthropic.Beta.BetaContentBlockParam[] {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  const notes: string[] = [];
  for (const photo of turn.photos ?? []) {
    convo.photos.push(photo);
    content.push({
      type: "image",
      source: { type: "base64", media_type: photo.mimeType as "image/jpeg", data: photo.base64 },
    });
    notes.push(`[Shopper uploaded photo ${convo.photos.length}]`);
  }
  const text = [...notes, turn.text.trim()].filter(Boolean).join("\n");
  content.push({ type: "text", text: text || "(no message)" });
  return content;
}

export async function runChatTurn(
  convo: Conversation,
  turn: UserTurn,
  emit: (e: ChatEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const startLength = convo.messages.length;
  const photosBefore = convo.photos.length;
  convo.messages.push({ role: "user", content: buildUserContent(convo, turn) });

  let jsonRetries = 0;
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const lastRound = round === MAX_TOOL_ROUNDS;
      const stream = getClient().beta.messages.stream(
        {
          model: CHAT_MODEL,
          max_tokens: 32_000,
          system: SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          // On the last round Claude must answer with what it has.
          tool_choice: lastRound ? { type: "none" } : { type: "auto" },
          messages: convo.messages,
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          // If the main model declines, Anthropic retries on its recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { signal },
      );

      stream.on("text", (delta) => void emit({ type: "text", text: delta }));
      stream.on("contentBlock", (block) => {
        if (block.type === "tool_use") void emit({ type: "tool_start", id: block.id, name: block.name, label: toolLabel(block.name, block.input) });
      });

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        // Tool inputs stream eagerly; if one couldn't be parsed at all, re-ask (a couple of times at most).
        if (err instanceof Anthropic.APIError || err instanceof Anthropic.APIUserAbortError || jsonRetries++ >= 2) throw err;
        round--;
        continue;
      }
      logUsage(message);

      if (message.stop_reason === "refusal") {
        throw new UserFacingError("Sorry, I can't help with that request.");
      }

      const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        throw new UserFacingError("My reply got too long. Please try a narrower question.");
      }

      convo.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });

      if (message.stop_reason === "pause_turn") continue;
      if (!toolUses.length) break;

      // Run all requested tools at once; every result goes back in a single message.
      const results = await Promise.all(
        toolUses.map(async (call): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          try {
            const outcome = await runTool(call.name, call.input, call.id, convo);
            if (outcome.ui) await emit(outcome.ui);
            await emit({ type: "tool_end", id: call.id, ok: !outcome.isError });
            return { type: "tool_result", tool_use_id: call.id, content: outcome.content, is_error: outcome.isError || undefined };
          } catch (err) {
            await emit({ type: "tool_end", id: call.id, ok: false });
            const message = err instanceof Error ? err.message : String(err);
            return { type: "tool_result", tool_use_id: call.id, is_error: true, content: JSON.stringify({ error: message }) };
          }
        }),
      );
      convo.messages.push({ role: "user", content: results });
    }
    await emit({ type: "done" });
  } catch (err) {
    // Roll back so the conversation stays valid (no half-finished tool calls).
    convo.messages.length = startLength;
    convo.photos.length = photosBefore;
    await emit({ type: "error", message: friendlyError(err) });
  }
}

class UserFacingError extends Error {}

function friendlyError(err: unknown): string {
  if (err instanceof UserFacingError) return err.message;
  if (err instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (err instanceof Anthropic.AuthenticationError) return "The AI service rejected the API key. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "The AI service is busy right now. Please try again in a moment.";
  if (err instanceof Anthropic.BadRequestError) {
    console.error("[chat] bad request:", err.message);
    return "Something went wrong with that request. Please start a new chat.";
  }
  if (err instanceof Anthropic.APIError) {
    console.error("[chat] API error:", err.status, err.message);
    return "The AI service had a problem. Please try again.";
  }
  console.error("[chat] error:", err);
  return "Something went wrong. Please try again.";
}

function logUsage(m: Anthropic.Beta.BetaMessage) {
  const u = m.usage;
  console.log(
    `[chat] ${m.model} stop=${m.stop_reason} in=${u.input_tokens} cache_read=${u.cache_read_input_tokens ?? 0} ` +
      `cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens}`,
  );
}
