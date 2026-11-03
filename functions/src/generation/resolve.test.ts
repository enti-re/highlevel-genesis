import { describe, expect, it } from "vitest";
import type { ParseResult } from "./parser";
import { applyRepair, resolveEdits } from "./resolve";
import { deriveStatus } from "./save";

const result = (over: Partial<ParseResult>): ParseResult =>
  ({ text: "", completed: new Map(), deleted: [], edits: [], incomplete: null, ...over }) as ParseResult;
const edit = (search: string, replace: string) => `<search>\n${search}\n</search>\n<replace>\n${replace}\n</replace>`;

describe("resolveEdits", () => {
  const existing = new Map([["app.js", "const a = 1;\nconst b = 2;"]]);

  it("turns edits into full file contents", () => {
    const r = resolveEdits(existing, result({ edits: [{ path: "app.js", body: edit("const a = 1;", "const a = 10;") }] }));
    expect(r.proposed.get("app.js")).toBe("const a = 10;\nconst b = 2;");
    expect(r.stats).toMatchObject({ applied: 1, failed: 0 });
  });

  it("is atomic per file: one bad edit leaves the whole file untouched", () => {
    const r = resolveEdits(
      existing,
      result({
        edits: [
          { path: "app.js", body: edit("const a = 1;", "const a = 10;") },
          { path: "app.js", body: edit("not in file", "x") },
        ],
      }),
    );
    expect(r.proposed.has("app.js")).toBe(false);
    expect(r.failures.get("app.js")).toMatch(/block 1/);
  });

  it("fails edits to a file that doesn't exist", () => {
    const r = resolveEdits(existing, result({ edits: [{ path: "nope.js", body: edit("a", "b") }] }));
    expect(r.failures.get("nope.js")).toBe("the file doesn't exist");
  });
});

describe("applyRepair", () => {
  it("takes only the requested paths from the repair answer", () => {
    const resolved = {
      proposed: new Map(),
      failures: new Map([["app.js", "x"]]),
      stats: { applied: 0, failed: 1, repaired: 0, syntaxRepaired: 0 },
    };
    const r = applyRepair(
      resolved,
      new Map([
        ["app.js", "fixed"],
        ["other.js", "invented"],
      ]),
      ["app.js"],
    );
    expect([...r.proposed]).toEqual([["app.js", "fixed"]]);
    expect(r.failures.size).toBe(0);
    expect(r.stats.repaired).toBe(1);
    expect(r.stats.failed).toBe(0); // repaired edits must not also count as failed (lowered confidence)
  });
});

describe("deriveStatus", () => {
  const fail = (code: string) => ({ code, message: "", retryable: false });
  it.each([
    [null, 2, "complete"],
    [null, 0, "no_changes"],
    [fail("LLM_UNAVAILABLE"), 1, "partial"],
    [fail("LLM_UNAVAILABLE"), 0, "failed"],
    [fail("CANCELLED"), 1, "cancelled_partial"],
    [fail("CANCELLED"), 0, "cancelled"],
  ] as const)("%j with %i changes -> %s", (failure, changed, status) => {
    expect(deriveStatus(failure, changed)).toBe(status);
  });
});
