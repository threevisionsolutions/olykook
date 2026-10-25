/**
 * Chat conversations, kept in memory for 2 hours.
 * History is append-only: Claude Opus 5.5 requires earlier turns to be sent back byte-for-byte.
 * Swap for Redis/a database when you run more than one server or want chats to survive restarts.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { TtlCache } from "../lib/cache.js";
import type { ImageInput, Product } from "../types.js";

export interface Conversation {
  id: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Every product a tool has returned, so show_recommendations can refer to them by id. */
  products: Map<string, Product>;
  /** Photos the shopper uploaded, in order (photo 1, photo 2…). */
  photos: ImageInput[];
  busy: boolean;
}

const conversations = new TtlCache<Conversation>(2 * 60 * 60_000, 1000);

export function getConversation(id: string | undefined): Conversation | undefined {
  return id ? conversations.get(id) : undefined;
}

export function createConversation(): Conversation {
  const convo: Conversation = { id: randomUUID(), messages: [], products: new Map(), photos: [], busy: false };
  conversations.set(convo.id, convo);
  return convo;
}

/** Refresh the expiry after each turn. */
export function touch(convo: Conversation) {
  conversations.set(convo.id, convo);
}
