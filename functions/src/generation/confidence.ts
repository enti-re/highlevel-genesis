import { OPERATION_NAMES } from "../hl/operations";
import { jsSyntaxErrors } from "./syntax";

/**
 * How likely a saved app is to work, from mechanical checks rather than the
 * model's self-rating (poorly calibrated). evals/run.ts calibrates the score.
 */
export interface Confidence {
  score: number;
  level: "high" | "medium" | "low";
  reasons: string[];
}

export interface ConfidenceInput {
  status: string;
  files: Map<string, string>;
  warnings: string[];
  incomplete: boolean;
  edits: { applied: number; failed: number; repaired: number };
}

/** Browser APIs the preview blocks or the system prompt forbids; code using them breaks or leaks. */
export const FORBIDDEN_API = /\bfetch\s*\(|XMLHttpRequest|localStorage|sessionStorage|window\.parent|document\.cookie|new\s+WebSocket/;

const KNOWN_OPS = new Set([...OPERATION_NAMES, "contacts.listAll"]);

/** `hl.<group>.<method>` calls that aren't in the window.hl API (they throw at runtime). */
export function unknownHlOps(code: string): string[] {
  const used = new Set([...code.matchAll(/\bhl\.([a-zA-Z]+)\.([a-zA-Z]+)\b/g)].map((m) => `${m[1]}.${m[2]}`));
  return [...used].filter((op) => !KNOWN_OPS.has(op));
}

/** Local scripts/stylesheets referenced by index.html that don't exist. */
export function missingLocalRefs(files: Map<string, string>): string[] {
  const html = files.get("index.html") ?? "";
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  return refs
    .filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith("data:"))
    .map((r) => r.replace(/^\.\//, "").split(/[?#]/)[0])
    .filter((r) => !files.has(r));
}

export function scoreConfidence(input: ConfidenceInput): Confidence {
  const reasons: string[] = [];
  let score = 100;
  const penalize = (points: number, reason: string) => {
    score -= points;
    reasons.push(reason);
  };

  if (input.status === "failed" || input.status === "cancelled" || input.files.size === 0) {
    return { score: 0, level: "low", reasons: ["no working version was saved"] };
  }
  if (input.status !== "complete" && input.status !== "no_changes") penalize(40, "generation stopped early (partial save)");
  if (input.incomplete) penalize(30, "a file was cut off and not saved");
  if (!input.files.has("index.html")) penalize(40, "no index.html");

  const missing = missingLocalRefs(input.files);
  if (missing.length) penalize(30, `index.html references missing files: ${missing.join(", ")}`);

  const syntax = jsSyntaxErrors(input.files);
  if (syntax.size) penalize(50, `JavaScript syntax error, the app won't load: ${[...syntax].map(([p, e]) => `${p}: ${e}`).join("; ")}`);

  const code = [...input.files.entries()]
    .filter(([p]) => /\.(js|html)$/.test(p))
    .map(([, c]) => c)
    .join("\n");
  const unknown = unknownHlOps(code);
  if (unknown.length) penalize(25, `calls HighLevel operations that don't exist: ${unknown.join(", ")}`);
  if (FORBIDDEN_API.test(code)) penalize(30, "uses browser APIs the preview blocks (fetch/storage/parent)");
  if (/\bhl\./.test(code) && !/genesis\.useHl|errorText|catch\s*\(/.test(code))
    penalize(10, "HighLevel calls without loading/error handling");

  if (input.edits.failed) penalize(25, `${input.edits.failed} edit(s) could not be applied`);
  if (input.edits.repaired) penalize(10, "an edit needed a full-file repair");
  if (input.warnings.length) penalize(Math.min(20, 10 * input.warnings.length), `${input.warnings.length} validation warning(s)`);

  score = Math.max(0, score);
  return { score, level: score >= 80 ? "high" : score >= 50 ? "medium" : "low", reasons };
}
