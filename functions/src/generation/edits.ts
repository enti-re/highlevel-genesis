/**
 * Search/replace edits, so small changes don't re-send whole files (output tokens are the main cost):
 *
 *   <edit path="app.js">
 *   <search>
 *   exact lines from the current file
 *   </search>
 *   <replace>
 *   new lines
 *   </replace>
 *   </edit>
 *
 * All-or-nothing per file: a block that can't be located unambiguously rejects the whole edit.
 */

export interface EditBlock {
  search: string;
  replace: string;
}

const BLOCK = /<search>\r?\n?([\s\S]*?)\r?\n?<\/search>\s*<replace>\r?\n?([\s\S]*?)\r?\n?<\/replace>/g;

const TAG = /<\/?(search|replace)>/;

/** Strict: malformed tags reject the edit (it goes to repair) instead of dropping a block or writing tag markup into the file. */
export function parseEditBody(body: string): EditBlock[] | { reason: string } {
  const blocks: EditBlock[] = [];
  for (const m of body.matchAll(BLOCK)) {
    if (TAG.test(m[1]) || TAG.test(m[2])) return { reason: `edit block ${blocks.length + 1} is malformed (nested or unclosed tags)` };
    blocks.push({ search: m[1], replace: m[2] });
  }
  if (body.replace(BLOCK, "").trim()) return { reason: "edit has text outside <search>/<replace> blocks (malformed tags)" };
  return blocks;
}

export type ApplyResult = { ok: true; content: string } | { ok: false; reason: string };

export function applyEdits(content: string, blocks: EditBlock[]): ApplyResult {
  if (blocks.length === 0) return { ok: false, reason: "edit had no search/replace blocks" };
  let current = content;
  for (const [i, block] of blocks.entries()) {
    if (!block.search.trim()) return { ok: false, reason: `edit block ${i + 1} has an empty search` };
    const next = replaceOnce(current, block);
    if (typeof next !== "string") return { ok: false, reason: `edit block ${i + 1}: ${next.reason}` };
    current = next;
  }
  return { ok: true, content: current };
}

function replaceOnce(content: string, { search, replace }: EditBlock): string | { reason: string } {
  // 1. Exact match. Slicing (not String.replace) so "$" in code is never treated as a pattern.
  const first = content.indexOf(search);
  if (first !== -1) {
    if (content.indexOf(search, first + 1) !== -1) return { reason: "search text matches more than once" };
    return content.slice(0, first) + replace + content.slice(first + search.length);
  }

  // 2. Models often drift on indentation/trailing spaces: match line-by-line on trimmed text.
  const lines = content.split("\n");
  const wanted = search.split("\n").map((l) => l.trim());
  const hits: number[] = [];
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    if (wanted.every((w, j) => lines[start + j].trim() === w)) hits.push(start);
  }
  if (hits.length === 0) return { reason: "search text not found in the current file" };
  if (hits.length > 1) return { reason: "search text matches more than once" };
  const start = hits[0];
  return [...lines.slice(0, start), ...replace.split("\n"), ...lines.slice(start + wanted.length)].join("\n");
}
