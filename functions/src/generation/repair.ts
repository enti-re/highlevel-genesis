import { logger } from "firebase-functions";
import { applyRepair, type ResolvedEdits } from "./resolve";
import { jsSyntaxErrors } from "./syntax";
import { stripCodeFence, stripWrapperTags } from "./validate";

/** One extra model call that returns complete corrected files for `paths`. */
export type RequestRepair = (paths: string[], problem: string) => Promise<Map<string, string>>;

interface RepairContext {
  requestRepair: RequestRepair;
  warn: (message: string) => void;
  logFields: { projectId: string; generationId: string };
}

/**
 * Edits whose search text didn't match: ask once for the whole file. Files the model never saw
 * (omitted for length) stay failed, because a "complete rewrite" of them would be invented.
 */
export async function repairFailedEdits(resolved: ResolvedEdits, omittedFiles: string[], ctx: RepairContext): Promise<ResolvedEdits> {
  for (const [path, reason] of resolved.failures) logger.warn("edit_failed", { ...ctx.logFields, path, reason });
  const repairable = [...resolved.failures].filter(([path]) => !omittedFiles.includes(path));
  if (!repairable.length) return resolved;

  const paths = repairable.map(([path]) => path);
  ctx.warn(`A quick edit to ${paths.join(", ")} didn't match, so rewriting it in full.`);
  const reasons = repairable.map(([path, reason]) => `- ${path}: ${reason}`).join("\n");
  const files = await ctx.requestRepair(
    paths,
    `These edits could not be applied:\n${reasons}\n\nApply every change from your previous answer.`,
  );
  return applyRepair(resolved, files, paths);
}

/**
 * A syntax error in app.js means a blank preview: ask once for a fix and keep it only if it parses.
 * Checked after the cleanup validation applies, so a stray fence or wrapper tag isn't sent for repair.
 */
export async function repairSyntaxErrors(resolved: ResolvedEdits, ctx: RepairContext): Promise<void> {
  const cleaned = new Map([...resolved.proposed].map(([path, content]) => [path, stripWrapperTags(path, stripCodeFence(content))]));
  const syntaxErrors = jsSyntaxErrors(cleaned);
  if (!syntaxErrors.size) return;

  const paths = [...syntaxErrors.keys()];
  for (const [path, error] of syntaxErrors) logger.warn("syntax_error", { ...ctx.logFields, path, error });
  ctx.warn(`${paths.join(", ")} had a JavaScript syntax error, fixing it.`);
  const errors = [...syntaxErrors].map(([path, error]) => `- ${path}: ${error}`).join("\n");
  const files = await ctx.requestRepair(
    paths,
    `Your code has JavaScript syntax errors:\n${errors}\nA common cause is a backtick or \${...} inside the backtick template string.`,
  );
  const parses = (path: string, content: string) => jsSyntaxErrors(new Map([[path, content]])).size === 0;
  const fixed = [...files].filter(([path, content]) => paths.includes(path) && parses(path, content));
  for (const [path, content] of fixed) resolved.proposed.set(path, content);
  resolved.stats.syntaxRepaired = fixed.length;
}
