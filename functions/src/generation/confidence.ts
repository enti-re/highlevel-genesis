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

const MAX_SCORE = 100;
const HIGH_CONFIDENCE = 80;
const MEDIUM_CONFIDENCE = 50;
/** Points off per problem, sized by how likely it is to leave the app blank or broken. */
const PENALTY = {
  syntaxError: 50,
  partialSave: 40,
  noEntryFile: 40,
  cutOffFile: 30,
  missingFiles: 30,
  blockedApi: 30,
  unknownOperation: 25,
  failedEdit: 25,
  repairedEdit: 10,
  noErrorHandling: 10,
  perWarning: 10,
  maxWarnings: 20,
};

const KNOWN_OPS = new Set([...OPERATION_NAMES, "contacts.listAll"]);

/** `hl.<group>.<method>` calls that aren't in the window.hl API (they throw at runtime). */
export function unknownHlOps(code: string): string[] {
  const used = new Set([...code.matchAll(/\bhl\.([a-zA-Z]+)\.([a-zA-Z]+)\b/g)].map((match) => `${match[1]}.${match[2]}`));
  return [...used].filter((op) => !KNOWN_OPS.has(op));
}

/** Local scripts/stylesheets referenced by index.html that don't exist. */
export function missingLocalRefs(files: Map<string, string>): string[] {
  const html = files.get("index.html") ?? "";
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  return refs
    .filter((ref) => !/^(https?:)?\/\//.test(ref) && !ref.startsWith("data:"))
    .map((ref) => ref.replace(/^\.\//, "").split(/[?#]/)[0])
    .filter((ref) => !files.has(ref));
}

export function scoreConfidence(input: ConfidenceInput): Confidence {
  const reasons: string[] = [];
  let score = MAX_SCORE;
  const penalize = (points: number, reason: string) => {
    score -= points;
    reasons.push(reason);
  };

  if (input.status === "failed" || input.status === "cancelled" || input.files.size === 0) {
    return { score: 0, level: "low", reasons: ["no working version was saved"] };
  }
  if (input.status !== "complete" && input.status !== "no_changes")
    penalize(PENALTY.partialSave, "generation stopped early (partial save)");
  if (input.incomplete) penalize(PENALTY.cutOffFile, "a file was cut off and not saved");
  if (!input.files.has("index.html")) penalize(PENALTY.noEntryFile, "no index.html");

  const missing = missingLocalRefs(input.files);
  if (missing.length) penalize(PENALTY.missingFiles, `index.html references missing files: ${missing.join(", ")}`);

  const syntax = jsSyntaxErrors(input.files);
  if (syntax.size)
    penalize(
      PENALTY.syntaxError,
      `JavaScript syntax error, the app won't load: ${[...syntax].map(([path, error]) => `${path}: ${error}`).join("; ")}`,
    );

  const code = [...input.files.entries()]
    .filter(([path]) => /\.(js|html)$/.test(path))
    .map(([, content]) => content)
    .join("\n");
  const unknown = unknownHlOps(code);
  if (unknown.length) penalize(PENALTY.unknownOperation, `calls HighLevel operations that don't exist: ${unknown.join(", ")}`);
  if (FORBIDDEN_API.test(code)) penalize(PENALTY.blockedApi, "uses browser APIs the preview blocks (fetch/storage/parent)");
  if (/\bhl\./.test(code) && !/genesis\.useHl|errorText|catch\s*\(/.test(code))
    penalize(PENALTY.noErrorHandling, "HighLevel calls without loading/error handling");

  if (input.edits.failed) penalize(PENALTY.failedEdit, `${input.edits.failed} edit(s) could not be applied`);
  if (input.edits.repaired) penalize(PENALTY.repairedEdit, "an edit needed a full-file repair");
  if (input.warnings.length)
    penalize(Math.min(PENALTY.maxWarnings, PENALTY.perWarning * input.warnings.length), `${input.warnings.length} validation warning(s)`);

  score = Math.max(0, score);
  return { score, level: score >= HIGH_CONFIDENCE ? "high" : score >= MEDIUM_CONFIDENCE ? "medium" : "low", reasons };
}
