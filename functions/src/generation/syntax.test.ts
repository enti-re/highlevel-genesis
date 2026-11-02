import { describe, expect, it } from "vitest";
import { jsSyntaxErrors } from "./syntax";

describe("jsSyntaxErrors", () => {
  it("catches a backtick inside a template-literal Vue template, with the line", () => {
    const app = "const t = `\n<span>{{ `${a} ${b}` }}</span>\n`;\ncreateApp({ template: t });";
    const errors = jsSyntaxErrors(new Map([["app.js", app]]));
    expect(errors.get("app.js")).toMatch(/Unexpected|Invalid|token|identifier/i);
    expect(errors.get("app.js")).toMatch(/line \d+/);
  });

  it("passes valid code and never runs it", () => {
    const errors = jsSyntaxErrors(
      new Map([
        ["app.js", "throw new Error('would run'); const x = `${1}`;"],
        ["index.html", "<not js>"],
      ]),
    );
    expect(errors.size).toBe(0);
  });
});
