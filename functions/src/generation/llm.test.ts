import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { shouldFallBack } from "./llm";

const apiError = (status: number, message = "error") => new Anthropic.APIError(status, undefined, message, new Headers());

describe("shouldFallBack (Claude -> Gemini, before the first token only)", () => {
  it.each([429, 500, 529, 401, 403])("falls back when Claude is unavailable to us (%i)", (status) => {
    expect(shouldFallBack(apiError(status))).toBe(true);
  });

  it("falls back when the account is out of credits", () => {
    expect(shouldFallBack(apiError(400, "Your credit balance is too low to access the Anthropic API."))).toBe(true);
  });

  it("falls back on connection errors", () => {
    expect(shouldFallBack(new Anthropic.APIConnectionError({ message: "socket hang up" }))).toBe(true);
  });

  it("does not fall back on a bad request or a non-API error (another model wouldn't fix it)", () => {
    expect(shouldFallBack(apiError(400, "prompt is too long"))).toBe(false);
    expect(shouldFallBack(new Error("boom"))).toBe(false);
  });
});
