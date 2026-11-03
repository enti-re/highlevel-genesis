import Anthropic from "@anthropic-ai/sdk";
import { logger } from "firebase-functions";
import { ANTHROPIC_API_KEY, GEMINI_API_KEY, LLM_MODEL, LLM_PROVIDER, isMockLlm } from "../config";
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
  /** Set when a different model than activeModel() answered (provider fallback). */
  model?: string;
}

let client: Anthropic | null = null;
// With a fallback configured, retrying Claude for minutes on a rate limit is worse than switching.
const getClient = () =>
  (client ??= new Anthropic({ apiKey: ANTHROPIC_API_KEY.value(), maxRetries: GEMINI_API_KEY.value() ? 1 : 2, timeout: 8 * 60 * 1000 }));

/** Recorded on each generation for cost and eval reports. */
export function activeModel(): string {
  if (isMockLlm()) return "mock";
  if (LLM_PROVIDER.value() === "gemini") return geminiModel();
  return LLM_MODEL.value();
}

const geminiModel = () => process.env.GEMINI_MODEL || "gemini-3.5-flash";

/** SDK retries happen before the first token only, so a retry never duplicates output the user has seen. */
export async function streamCompletion(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  onChunk: (chunk: LlmChunk) => void,
): Promise<LlmResult> {
  if (isMockLlm()) return mockCompletion(messages, signal, onChunk);
  if (LLM_PROVIDER.value() === "gemini") return geminiCompletion(messages, signal, onChunk);

  let streamed = false;
  try {
    return await claudeCompletion(messages, signal, (chunk) => {
      streamed = true;
      onChunk(chunk);
    });
  } catch (err) {
    // Capacity/billing failures before any output switch to Gemini; after output starts, switching
    // would mix two answers, so the error stands.
    if (streamed || signal.aborted || !shouldFallBack(err) || !GEMINI_API_KEY.value()) throw err;
    logger.warn("llm_fallback", { from: LLM_MODEL.value(), to: geminiModel(), reason: (err as Error).message?.slice(0, 200) });
    let fallbackStreamed = false;
    try {
      const result = await geminiCompletion(messages, signal, (chunk) => {
        fallbackStreamed = true;
        onChunk(chunk);
      });
      return { ...result, model: geminiModel() };
    } catch (fallbackErr) {
      logger.warn("llm_fallback_failed", { reason: (fallbackErr as Error).message?.slice(0, 200) });
      // Once Gemini produced output, its error describes what the user saw; before that, Claude's does.
      throw fallbackStreamed ? fallbackErr : err;
    }
  }
}

/** Claude unavailable to us (rate limit, overload, no credits, missing/invalid key), not a problem with the request. */
export function shouldFallBack(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (!(err instanceof Anthropic.APIError)) return false;
  const status = err.status ?? 0;
  if (status === 429 || status >= 500 || status === 401 || status === 403) return true;
  return status === 400 && /credit balance/i.test(err.message);
}

async function claudeCompletion(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  onChunk: (chunk: LlmChunk) => void,
): Promise<LlmResult> {
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
