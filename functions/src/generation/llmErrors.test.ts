import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { LlmHttpError } from "./gemini";
import { addUsage, classifyError } from "./llmErrors";

const live = new AbortController().signal;
const aborted = (reason: string) => {
  const c = new AbortController();
  c.abort(reason);
  return c.signal;
};
const headers = new Headers();

describe("classifyError", () => {
  it("cancel and timeout win over the underlying error, and say finished files were kept", () => {
    expect(classifyError(new Error("x"), aborted("cancelled"))).toMatchObject({ code: "CANCELLED", retryable: false });
    expect(classifyError(new Error("x"), aborted("timeout"))).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(classifyError(new Error("x"), aborted("timeout")).message).toMatch(/Finished files were kept/);
  });

  it.each([
    [new Anthropic.RateLimitError(429, undefined, "slow down", headers), "LLM_RATE_LIMITED", true],
    [new Anthropic.AuthenticationError(401, undefined, "bad key", headers), "LLM_CONFIG", false],
    [new Anthropic.PermissionDeniedError(403, undefined, "nope", headers), "LLM_CONFIG", false],
    [new Anthropic.BadRequestError(400, undefined, "prompt is too long", headers), "LLM_BAD_REQUEST", false],
    [new Anthropic.APIConnectionError({ message: "socket hang up" }), "LLM_CONNECTION", true],
    [new Anthropic.InternalServerError(529, undefined, "overloaded", headers), "LLM_UNAVAILABLE", true],
  ])("Claude %s -> %s (retryable %s)", (err, code, retryable) => {
    expect(classifyError(err, live)).toMatchObject({ code, retryable });
  });

  it("an out-of-credits 400 is a config problem, not a 'too large' request", () => {
    const err = new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low to access the Anthropic API.", headers);
    expect(classifyError(err, live)).toMatchObject({ code: "LLM_CONFIG", retryable: false, message: expect.stringMatching(/credits/) });
  });

  it.each([
    [429, "LLM_RATE_LIMITED", true],
    [401, "LLM_CONFIG", false],
    [503, "LLM_UNAVAILABLE", true],
    [400, "LLM_BAD_REQUEST", false],
  ])("Gemini HTTP %i -> %s", (status, code, retryable) => {
    expect(classifyError(new LlmHttpError(status, "gemini error"), live)).toMatchObject({ code, retryable });
  });

  it("anything unknown is INTERNAL and retryable, never a raw stack to the user", () => {
    const out = classifyError(new TypeError("cannot read properties of undefined"), live);
    expect(out).toMatchObject({ code: "INTERNAL", retryable: true });
    expect(out.message).not.toMatch(/undefined/);
  });
});

describe("addUsage", () => {
  it("sums the main call and repair calls, tolerating a missing side", () => {
    const u = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreationTokens: 1 };
    expect(addUsage(u, u)).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 4, cacheCreationTokens: 2 });
    expect(addUsage(null, u)).toBe(u);
    expect(addUsage(u, null)).toBe(u);
  });
});
