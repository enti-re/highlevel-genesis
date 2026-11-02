import { describe, expect, it } from "vitest";
import { LIMITS, stripCodeFence, stripWrapperTags, validateFileOps, validatePath } from "./validate";

describe("validatePath", () => {
  it.each(["index.html", "app.js", "components/contact-list.js", "assets/logo.svg"])("accepts %s", (p) =>
    expect(validatePath(p)).toBeNull(),
  );
  it.each(["/etc/passwd", "../secret.js", "a/../../b.js", "a\\b.js", "server.py", "", "a/b/c/d.js", ".env"])("rejects %s", (p) =>
    expect(validatePath(p)).not.toBeNull(),
  );
});

describe("stripCodeFence", () => {
  it("removes a wrapping fence", () => expect(stripCodeFence("```js\nconst a = 1;\n```")).toBe("const a = 1;"));
  it("leaves fences inside content alone", () => expect(stripCodeFence("# Title\n```js\nx\n```\nmore")).toContain("more"));
});

describe("stripWrapperTags", () => {
  it("removes a stray closing </script> at the end of a .js file", () =>
    expect(stripWrapperTags("app.js", "createApp({}).mount('#app');\n</script>\n")).toBe("createApp({}).mount('#app');"));
  it("removes a full <script> wrapper", () =>
    expect(stripWrapperTags("app.js", '<script type="text/javascript">\nconst a = 1;\n</script>')).toBe("const a = 1;"));
  it("removes a <style> wrapper from css", () => expect(stripWrapperTags("s.css", "<style>\nbody{}\n</style>")).toBe("body{}"));
  it("keeps tags that appear inside code", () => {
    const js = "const html = '<script></script>';\nrender(html);";
    expect(stripWrapperTags("app.js", js)).toBe(js);
  });
  it("leaves html files alone", () => expect(stripWrapperTags("index.html", "<script></script>")).toBe("<script></script>"));
});

describe("validateFileOps", () => {
  const existing = new Map([
    ["index.html", "<html></html>"],
    ["old.js", "x"],
  ]);

  it("keeps valid files and rejects bad ones individually", () => {
    const r = validateFileOps(
      existing,
      new Map([
        ["app.js", "console.log(1)"],
        ["../evil.js", "x"],
        ["empty.css", "   "],
      ]),
      new Set(["old.js", "missing.js"]),
    );
    expect([...r.accepted.keys()]).toEqual(["app.js"]);
    expect(r.rejected.map((x) => x.path).sort()).toEqual(["../evil.js", "empty.css"]);
    expect([...r.deletes]).toEqual(["old.js"]);
    expect([...r.merged.keys()].sort()).toEqual(["app.js", "index.html"]);
  });

  it("warns when there is no index.html", () => {
    const r = validateFileOps(new Map(), new Map([["app.js", "1"]]), new Set());
    expect(r.warnings.some((w) => w.includes("index.html"))).toBe(true);
  });

  it("drops new files beyond the project file limit", () => {
    const many = new Map(Array.from({ length: LIMITS.maxFiles + 3 }, (_, i) => [`f${i}.js`, "1"]));
    const r = validateFileOps(new Map(), many, new Set());
    expect(r.merged.size).toBe(LIMITS.maxFiles);
    expect(r.rejected).toHaveLength(3);
  });
});
