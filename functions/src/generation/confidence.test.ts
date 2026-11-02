import { describe, expect, it } from "vitest";
import { missingLocalRefs, scoreConfidence, unknownHlOps } from "./confidence";

const GOOD = new Map([
  [
    "index.html",
    '<html><head><link rel="stylesheet" href="styles.css"></head><body><div id="app"></div><script src="app.js"></script></body></html>',
  ],
  ["app.js", "const { data } = genesis.useHl(() => hl.contacts.list({ limit: 20 }))"],
  ["styles.css", "body{}"],
]);
const base = { status: "complete", files: GOOD, warnings: [], incomplete: false, edits: { applied: 0, failed: 0, repaired: 0 } };

describe("scoreConfidence", () => {
  it("a clean generation is high confidence", () => {
    expect(scoreConfidence(base)).toEqual({ score: 100, level: "high", reasons: [] });
  });

  it("a failed generation is zero", () => {
    expect(scoreConfidence({ ...base, status: "failed" }).score).toBe(0);
  });

  it("penalizes forbidden APIs, unknown ops and missing files, with reasons", () => {
    const files = new Map(GOOD);
    files.set("index.html", '<script src="main.js"></script>');
    files.set("app.js", "fetch('/x'); hl.contacts.deleteAll()");
    const c = scoreConfidence({ ...base, files });
    expect(c.level).toBe("low");
    expect(c.reasons.join(" ")).toMatch(/missing files: main\.js/);
    expect(c.reasons.join(" ")).toMatch(/contacts\.deleteAll/);
    expect(c.reasons.join(" ")).toMatch(/browser APIs/);
  });

  it("a repaired edit lowers confidence a little, a failed one a lot", () => {
    expect(scoreConfidence({ ...base, edits: { applied: 1, failed: 0, repaired: 1 } }).score).toBe(90);
    expect(scoreConfidence({ ...base, edits: { applied: 0, failed: 1, repaired: 0 } }).level).toBe("medium");
  });
});

describe("helpers", () => {
  it("unknownHlOps knows listAll and the real operations", () => {
    expect(unknownHlOps("hl.contacts.listAll(); hl.calendars.events(); hl.contacts.purge()")).toEqual(["contacts.purge"]);
  });
  it("missingLocalRefs ignores CDN and data URLs", () => {
    const files = new Map([
      ["index.html", '<script src="https://cdn.x/vue.js"></script><script src="./app.js"></script><script src="b.js"></script>'],
      ["app.js", ""],
    ]);
    expect(missingLocalRefs(files)).toEqual(["b.js"]);
  });
});
