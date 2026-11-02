import { describe, expect, it } from "vitest";
import { FileStreamParser, ParserEvent } from "./parser";

/** Feeds `input` in fixed-size chunks to simulate arbitrary token boundaries. */
function run(input: string, chunkSize: number) {
  const parser = new FileStreamParser();
  const events: ParserEvent[] = [];
  for (let i = 0; i < input.length; i += chunkSize) events.push(...parser.feed(input.slice(i, i + chunkSize)));
  const { events: tail, result } = parser.finish();
  return { events: [...events, ...tail], result };
}

const SAMPLE = `Building a dashboard.
<file path="index.html">
<!doctype html><div id="app"></div>
</file>
<file path="app.js">
const a = "<b>not a tag</b>"; // contains </fil but not the close tag
console.log(a);
</file>
<delete path="old.js"/>
Done!`;

describe("FileStreamParser", () => {
  it.each([1, 2, 3, 7, 16, 1000])("parses identically with chunk size %i", (size) => {
    const { result } = run(SAMPLE, size);
    expect([...result.completed.keys()]).toEqual(["index.html", "app.js"]);
    expect(result.completed.get("index.html")).toBe('<!doctype html><div id="app"></div>');
    expect(result.completed.get("app.js")).toBe('const a = "<b>not a tag</b>"; // contains </fil but not the close tag\nconsole.log(a);');
    expect([...result.deleted]).toEqual(["old.js"]);
    expect(result.text).toBe("Building a dashboard.\n\nDone!");
    expect(result.incomplete).toBeNull();
  });

  it("streamed file deltas reassemble to the file content", () => {
    const { events } = run(SAMPLE, 3);
    const streamed = events
      .filter((e): e is Extract<ParserEvent, { type: "file_delta" }> => e.type === "file_delta" && e.path === "app.js")
      .map((e) => e.text)
      .join("");
    expect(streamed.replace(/\n$/, "")).toBe(run(SAMPLE, 1000).result.completed.get("app.js"));
  });

  it("flags a file that was cut off mid-stream and keeps earlier files", () => {
    const cut = SAMPLE.slice(0, SAMPLE.indexOf("console.log"));
    const { result } = run(cut, 5);
    expect([...result.completed.keys()]).toEqual(["index.html"]);
    expect(result.incomplete?.path).toBe("app.js");
  });

  it("treats a never-closed opening tag as text instead of stalling", () => {
    const { result } = run(`<file path="${"x".repeat(400)}`, 10);
    expect(result.completed.size).toBe(0);
    expect(result.text.startsWith("<file path=")).toBe(true);
  });

  it("a later write to the same path wins and un-deletes it", () => {
    const { result } = run('<delete path="a.js"/><file path="a.js">\nv2\n</file>', 4);
    expect(result.completed.get("a.js")).toBe("v2");
    expect(result.deleted.has("a.js")).toBe(false);
  });
});

const EDIT_SAMPLE = `Adding a toggle.
<edit path="app.js">
<search>
const a = 1;
</search>
<replace>
const a = 2;
</replace>
</edit>
<file path="b.js">
x
</file>
<edit path="b.js">
<search>
x
</search>
<replace>
y
</replace>
</edit>
Done.`;

describe("FileStreamParser edits", () => {
  it.each([1, 3, 7, 1000])("collects edits without streaming them as file content (chunk %i)", (size) => {
    const { events, result } = run(EDIT_SAMPLE, size);
    expect(result.edits.map((e) => e.path)).toEqual(["app.js", "b.js"]);
    expect(result.edits[0].body).toContain("<search>\nconst a = 1;\n</search>");
    expect(events.some((e) => e.type === "file_delta" && e.path === "app.js")).toBe(false);
    expect(events.filter((e) => e.type === "edit_end").map((e) => e.path)).toEqual(["app.js", "b.js"]);
    expect(result.text).toBe("Adding a toggle.\n\nDone.");
  });

  it("a later full rewrite supersedes an earlier edit of the same file", () => {
    const { result } = run(`<edit path="a.js"><search>\nx\n</search><replace>\ny\n</replace></edit>\n<file path="a.js">\nz\n</file>`, 5);
    expect(result.edits).toEqual([]);
    expect(result.completed.get("a.js")).toBe("z");
  });

  it("flags an edit cut off by the end of the stream as incomplete", () => {
    const { result } = run(`<edit path="a.js">\n<search>\nx`, 4);
    expect(result.incomplete?.path).toBe("a.js");
    expect(result.edits).toEqual([]);
  });
});
