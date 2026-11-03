import Anthropic from "@anthropic-ai/sdk";
import { LlmHttpError } from "./gemini";
import type { LlmResult } from "./llm";

export type GenerationFailure = { code: string; message: string; retryable: boolean };

/** Sums token usage across the main call and any repair calls. */
export function addUsage(first: LlmResult["usage"], second: LlmResult["usage"]): LlmResult["usage"] {
  if (!first || !second) return first ?? second;
  return {
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cacheReadTokens: first.cacheReadTokens + second.cacheReadTokens,
    cacheCreationTokens: first.cacheCreationTokens + second.cacheCreationTokens,
  };
}

/** Maps an abort or provider error to a stable { code, message, retryable } for the UI. */
export function classifyError(err: unknown, signal: AbortSignal): GenerationFailure {
  if (signal.aborted) {
    return signal.reason === "timeout"
      ? { code: "TIMEOUT", message: "Generation took too long and was stopped. Finished files were kept.", retryable: true }
      : { code: "CANCELLED", message: "Generation cancelled. Finished files were kept.", retryable: false };
  }
  if (err instanceof LlmHttpError) {
    if (err.status === 429)
      return { code: "LLM_RATE_LIMITED", message: "The AI is busy right now. Please retry in a minute.", retryable: true };
    if (err.status === 401 || err.status === 403) return { code: "LLM_CONFIG", message: err.message, retryable: false };
    if (err.status >= 500)
      return { code: "LLM_UNAVAILABLE", message: "The AI service had an error. Finished files were kept.", retryable: true };
    return { code: "LLM_BAD_REQUEST", message: err.message, retryable: false };
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return { code: "LLM_CONFIG", message: "The AI service is misconfigured (API key). Please contact the app owner.", retryable: false };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { code: "LLM_RATE_LIMITED", message: "The AI is busy right now. Please retry in a minute.", retryable: true };
  }
  if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message)) {
    return { code: "LLM_CONFIG", message: "The AI account is out of credits. Please contact the app owner.", retryable: false };
  }
  if (err instanceof Anthropic.BadRequestError) {
    return { code: "LLM_BAD_REQUEST", message: "The AI rejected the request (it may be too large).", retryable: false };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { code: "LLM_CONNECTION", message: "Lost connection to the AI mid-generation. Finished files were kept.", retryable: true };
  }
  if (err instanceof Anthropic.APIError) {
    return { code: "LLM_UNAVAILABLE", message: "The AI service had an error. Finished files were kept.", retryable: true };
  }
  return { code: "INTERNAL", message: "Generation stopped unexpectedly. Finished files were kept.", retryable: true };
}
