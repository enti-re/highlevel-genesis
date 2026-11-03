import type Anthropic from "@anthropic-ai/sdk";
import type { LlmChunk, LlmResult } from "./llm";
import { MAX_OUTPUT_TOKENS, SYSTEM_PROMPT } from "./prompt";
import { GEMINI_API_KEY, secretValue } from "../config";

const SSE_DATA_PREFIX = "data:";

/** Alternative provider, opt-in with LLM_PROVIDER=gemini: local runs and testing without Claude credits. Claude is the default. */

export class LlmHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function geminiCompletion(
  messages: Anthropic.MessageParam[],
  signal: AbortSignal,
  onChunk: (chunk: LlmChunk) => void,
): Promise<LlmResult> {
  const apiKey = secretValue(GEMINI_API_KEY);
  if (!apiKey) throw new LlmHttpError(401, "GEMINI_API_KEY secret is not set.");
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: typeof message.content === "string" ? message.content : JSON.stringify(message.content) }],
        })),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
      signal,
    },
  );
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as any;
    throw new LlmHttpError(res.status, body?.error?.message ?? `Gemini request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let stopReason: string | null = null;
  let usage: LlmResult["usage"] = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith(SSE_DATA_PREFIX)) continue;
      const data = JSON.parse(line.slice(SSE_DATA_PREFIX.length));
      // Overload/quota errors can arrive mid-stream as an error object rather than an HTTP status.
      if (data.error) throw new LlmHttpError(Number(data.error.code) || 502, data.error.message ?? "Gemini stream error");
      const candidate = data.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (typeof part.text === "string" && !part.thought) onChunk({ type: "text", text: part.text });
      }
      if (candidate?.finishReason) {
        stopReason =
          { STOP: "end_turn", MAX_TOKENS: "max_tokens", SAFETY: "refusal" }[candidate.finishReason as string] ?? candidate.finishReason;
      }
      if (data.usageMetadata) {
        usage = {
          inputTokens: data.usageMetadata.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          cacheReadTokens: data.usageMetadata.cachedContentTokenCount ?? 0,
          cacheCreationTokens: 0,
        };
      }
    }
  }
  // A stream that closes without a finish reason was cut off, not completed.
  if (!stopReason) throw new LlmHttpError(502, "Gemini stream ended unexpectedly");
  return { stopReason, usage };
}
