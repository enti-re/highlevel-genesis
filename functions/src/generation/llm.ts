import Anthropic from "@anthropic-ai/sdk";
import { ANTHROPIC_API_KEY, LLM_MODEL, LLM_PROVIDER, isMockLlm } from "../config";
import { SYSTEM_PROMPT } from "./prompt";
import { mockCompletion } from "./mockLlm";
import { geminiCompletion } from "./gemini";

export type LlmChunk =
  | { type: "text"; text: string }
  /** The primary model declined and the server-side fallback model re-ran the request from scratch. */
  | { type: "restart" };

export interface LlmResult {
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null;
}

let client: Anthropic | null = null;
const getClient = () => (client ??= new Anthropic({ apiKey: ANTHROPIC_API_KEY.value(), maxRetries: 2, timeout: 8 * 60 * 1000 }));

/** Recorded on each generation for cost and eval reports. */
export function activeModel(): string {
  if (isMockLlm()) return "mock";
  if (LLM_PROVIDER.value() === "gemini") return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  return LLM_MODEL.value();
}

/** SDK retries happen before the first token only, so a retry never duplicates output the user has seen. */
export async function streamCompletion(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  onChunk: (chunk: LlmChunk) => void,
): Promise<LlmResult> {
  if (isMockLlm()) return mockCompletion(messages, signal, onChunk);
  if (LLM_PROVIDER.value() === "gemini") return geminiCompletion(messages, signal, onChunk);

  const stream = getClient().beta.messages.stream(
    {
      model: LLM_MODEL.value(),
      max_tokens: 32_000,
      output_config: { effort: "medium" },
      // Static system prompt -> cached across generations (cheaper + faster first token).
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: withCacheBreakpoint(messages),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as any, // `fallbacks` is newer than some SDK type definitions
    { signal },
  );

  for await (const event of stream) {
    if (event.type === "content_block_start" && (event.content_block as { type: string }).type === "fallback") {
      onChunk({ type: "restart" });
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      onChunk({ type: "text", text: event.delta.text });
    }
  }
  // Throws if the stream ended without message_stop, so a cut-off reply is never treated as complete.
  const final = await stream.finalMessage();
  return {
    stopReason: final.stop_reason ?? null,
    usage: {
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      // Cache writes bill at 1.25x input; without them the cost of a first request is under-counted.
      cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/**
 * Caches the conversation up to its last message (files, history, request). Follow-ups change the
 * files so they miss, but a repair call extends the same conversation and reads all of it from cache.
 */
function withCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  if (!last || typeof last.content !== "string") return messages;
  return [
    ...messages.slice(0, -1),
    { role: last.role, content: [{ type: "text", text: last.content, cache_control: { type: "ephemeral" } }] },
  ];
}
