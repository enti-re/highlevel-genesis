import { Script } from "node:vm";

/**
 * Parse-only check (vm.Script compiles, never runs). A syntax error means a blank preview,
 * so the server asks for a fix before saving. ES module files are skipped.
 */
export function jsSyntaxErrors(files: Map<string, string>): Map<string, string> {
  const errors = new Map<string, string>();
  for (const [path, code] of files) {
    if (!path.endsWith(".js") || /^\s*(import|export)\s/m.test(code)) continue;
    try {
      new Script(code, { filename: path });
    } catch (err) {
      if (!(err instanceof SyntaxError)) continue;
      const line = /:(\d+)\n/.exec(err.stack ?? "")?.[1];
      errors.set(path, `${err.message}${line ? ` (line ${line})` : ""}`);
    }
  }
  return errors;
}
