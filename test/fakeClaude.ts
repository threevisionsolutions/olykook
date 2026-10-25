/**
 * A scripted stand-in for the Claude Messages API streaming endpoint.
 * Each call to /v1/messages returns the next scripted reply as a real SSE stream.
 */
type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

export interface ScriptedReply {
  blocks?: Block[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  /** Return an HTTP error instead of a stream. */
  status?: number;
}

function sse(events: { event: string; data: unknown }[]): string {
  return events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
}

export function streamFor(reply: ScriptedReply, n: number): string {
  const blocks = reply.blocks ?? [];
  const stop = reply.stop_reason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  const events: { event: string; data: unknown }[] = [
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: `msg_${n}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: n > 1 ? 80 : 0, cache_creation_input_tokens: 0 },
        },
      },
    },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      // Split text in two deltas to exercise streaming.
      const half = Math.ceil(b.text.length / 2);
      for (const part of [b.text.slice(0, half), b.text.slice(half)]) {
        if (part) events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: part } } });
      }
    } else if (b.type === "thinking") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.thinking } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } } });
    } else {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } } });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({ event: "message_delta", data: { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 42 } } });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return sse(events);
}
