import type Anthropic from "@anthropic-ai/sdk";
import type { LlmChunk, LlmResult } from "./llm";
import { SYSTEM_PROMPT } from "./prompt";
import { GEMINI_API_KEY } from "../config";

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
  const apiKey = GEMINI_API_KEY.value();
  if (!apiKey) throw new LlmHttpError(401, "GEMINI_API_KEY secret is not set.");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
        })),
        generationConfig: { maxOutputTokens: 32_000 },
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
      if (!line.startsWith("data:")) continue;
      const data = JSON.parse(line.slice(5));
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
