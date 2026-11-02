import { describe, expect, it } from "vitest";
import { applyEdits, parseEditBody } from "./edits";

const FILE = `const a = 1;
function greet() {
  return "hi";
}
const b = 2;`;

describe("parseEditBody", () => {
  it("parses multiple blocks and keeps inner newlines", () => {
    const blocks = parseEditBody(`<search>
const a = 1;
</search>
<replace>
const a = 10;
const c = 3;
</replace>
<search>
const b = 2;
</search>
<replace>
</replace>`);
    expect(blocks).toEqual([
      { search: "const a = 1;", replace: "const a = 10;\nconst c = 3;" },
      { search: "const b = 2;", replace: "" },
    ]);
  });

  it("rejects a block with a missing </replace> instead of swallowing the next block", () => {
    const r = parseEditBody(`<search>
a
</search>
<replace>
b
<search>
c
</search>
<replace>
d
</replace>`);
    expect(r).toMatchObject({ reason: expect.stringMatching(/malformed/) });
  });

  it("rejects a misspelled tag instead of silently dropping that block", () => {
    const r = parseEditBody(`<serach>
a
</serach>
<replace>
b
</replace>
<search>
c
</search>
<replace>
d
</replace>`);
    expect(r).toMatchObject({ reason: expect.stringMatching(/malformed/) });
  });
});

describe("applyEdits", () => {
  it("applies blocks in order", () => {
    const r = applyEdits(FILE, [
      { search: 'return "hi";', replace: 'return "hello";' },
      { search: "const b = 2;", replace: "const b = 20;" },
    ]);
    expect(r).toEqual({ ok: true, content: FILE.replace('"hi"', '"hello"').replace("b = 2", "b = 20") });
  });

  it("treats $ in replacement text literally", () => {
    const r = applyEdits(FILE, [{ search: "const a = 1;", replace: "const a = `$${price}`;" }]);
    expect(r.ok && r.content.startsWith("const a = `$${price}`;")).toBe(true);
  });

  it("tolerates indentation drift via line-trimmed matching", () => {
    const r = applyEdits(FILE, [{ search: 'function greet() {\nreturn "hi";\n}', replace: "function greet() {\n  return 1;\n}" }]);
    expect(r.ok && r.content).toContain("  return 1;");
  });

  it("rejects text that is not found", () => {
    expect(applyEdits(FILE, [{ search: "nope", replace: "x" }])).toEqual({
      ok: false,
      reason: "edit block 1: search text not found in the current file",
    });
  });

  it("rejects ambiguous matches instead of guessing", () => {
    const r = applyEdits("x();\nx();", [{ search: "x();", replace: "y();" }]);
    expect(r.ok).toBe(false);
  });

  it("is all-or-nothing: a later failing block discards earlier ones", () => {
    const r = applyEdits(FILE, [
      { search: "const a = 1;", replace: "const a = 9;" },
      { search: "missing", replace: "" },
    ]);
    expect(r.ok).toBe(false);
  });

  it("rejects an edit with no blocks", () => {
    expect(applyEdits(FILE, []).ok).toBe(false);
  });
});
