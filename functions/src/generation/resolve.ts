import { applyEdits, parseEditBody } from "./edits";
import type { ParseResult } from "./parser";

export interface ResolvedEdits {
  proposed: Map<string, string>;
  stats: { applied: number; failed: number; repaired: number; syntaxRepaired: number };
  /** path -> why its edits couldn't be applied (those files are left untouched). */
  failures: Map<string, string>;
}

/** Edits -> whole files, atomic per file so a change is never half-applied. */
export function resolveEdits(existing: Map<string, string>, result: ParseResult): ResolvedEdits {
  const proposed = new Map(result.completed);
  const stats = { applied: 0, failed: 0, repaired: 0, syntaxRepaired: 0 };
  const failures = new Map<string, string>();
  const byPath = new Map<string, string[]>();
  for (const { path, body } of result.edits) byPath.set(path, [...(byPath.get(path) ?? []), body]);

  for (const [path, bodies] of byPath) {
    let content = proposed.get(path) ?? existing.get(path);
    let reason: string | null = content === undefined ? "the file doesn't exist" : null;
    for (const body of bodies) {
      if (reason || content === undefined) break;
      const blocks = parseEditBody(body);
      const applied = Array.isArray(blocks) ? applyEdits(content, blocks) : ({ ok: false, reason: blocks.reason } as const);
      if (applied.ok) content = applied.content;
      else reason = applied.reason;
    }
    if (reason || content === undefined) {
      stats.failed++;
      failures.set(path, reason ?? "the file doesn't exist");
    } else {
      stats.applied++;
      proposed.set(path, content);
    }
  }
  return { proposed, stats, failures };
}

/** Replaces failed edits with the full files the model re-sent; only the paths we asked to repair are taken. */
export function applyRepair(resolved: ResolvedEdits, files: Map<string, string>, paths: string[]): ResolvedEdits {
  const proposed = new Map(resolved.proposed);
  const failures = new Map(resolved.failures);
  let repaired = 0;
  for (const path of paths) {
    const content = files.get(path);
    if (content === undefined) continue;
    proposed.set(path, content);
    failures.delete(path);
    repaired++;
  }
  return { proposed, failures, stats: { ...resolved.stats, failed: resolved.stats.failed - repaired, repaired } };
}
