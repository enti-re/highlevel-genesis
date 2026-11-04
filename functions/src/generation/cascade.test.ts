import { describe, expect, it } from "vitest";
import { chooseTier, escalationReason } from "./cascade";
import type { ParseResult } from "./parser";
import type { ResolvedEdits } from "./resolve";

const GOOD_APP = new Map([
  [
    "index.html",
    '<html><head><link rel="stylesheet" href="styles.css"></head><body><div id="app"></div><script src="app.js"></script></body></html>',
  ],
  ["app.js", "const { data } = genesis.useHl(() => hl.contacts.list({ limit: 20 }))"],
  ["styles.css", "body{}"],
]);
const parsed = (over: Partial<ParseResult> = {}): ParseResult =>
  ({ text: "", completed: new Map(), deleted: new Set(), edits: [], incomplete: null, ...over }) as ParseResult;
const resolved = (proposed: Map<string, string>, failures = new Map<string, string>()): ResolvedEdits => ({
  proposed,
  failures,
  stats: { applied: 1, failed: failures.size, repaired: 0, syntaxRepaired: 0 },
});

describe("chooseTier", () => {
  it("new apps go to the best model", () => {
    expect(chooseTier({ hasFiles: false, prompt: "rename the title", enabled: true })).toBe("best");
  });
  it("short changes to an existing app try the fast model", () => {
    expect(chooseTier({ hasFiles: true, prompt: "rename the title to Patients", enabled: true })).toBe("fast");
  });
  it("long requests go to the best model, and the cascade can be turned off", () => {
    expect(chooseTier({ hasFiles: true, prompt: "x".repeat(301), enabled: true })).toBe("best");
    expect(chooseTier({ hasFiles: true, prompt: "rename", enabled: false })).toBe("best");
  });
});

describe("escalationReason", () => {
  const existing = new Map(GOOD_APP);
  existing.set("app.js", "const old = 1;");

  it("keeps a clean result", () => {
    expect(
      escalationReason({ existing, parsed: parsed(), resolved: resolved(new Map([["app.js", GOOD_APP.get("app.js")!]])), failure: null }),
    ).toBeNull();
  });

  it("escalates unapplied edits, cut-off files and low-confidence results", () => {
    expect(
      escalationReason({ existing, parsed: parsed(), resolved: resolved(new Map(), new Map([["app.js", "no match"]])), failure: null }),
    ).toMatch(/edits/);
    expect(
      escalationReason({
        existing,
        parsed: parsed({ incomplete: { path: "app.js" } } as Partial<ParseResult>),
        resolved: resolved(new Map()),
        failure: null,
      }),
    ).toMatch(/cut off/);
    const broken = new Map([["app.js", "const t = `\n<b>{{ `${x}` }}</b>\n`;"]]);
    expect(escalationReason({ existing, parsed: parsed(), resolved: resolved(broken), failure: null })).toMatch(/low confidence/);
  });

  it("never escalates provider failures or refusals (a bigger model wouldn't fix them)", () => {
    const failure = { code: "LLM_REFUSED", message: "", retryable: false };
    expect(escalationReason({ existing, parsed: parsed(), resolved: resolved(new Map(), new Map([["app.js", "x"]])), failure })).toBeNull();
  });
});
