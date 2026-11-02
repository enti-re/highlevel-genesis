/**
 * Validation for LLM-proposed file operations. The model's output is
 * untrusted input: bad paths or oversized files are rejected individually so
 * one mistake never throws away the rest of a generation.
 */

export const LIMITS = {
  maxFiles: 25,
  maxFileBytes: 120_000,
  maxProjectBytes: 450_000, // keeps a full snapshot well under Firestore's 1 MiB doc limit
  maxPathDepth: 3,
};

const ALLOWED_EXTENSIONS = new Set(["html", "js", "css", "json", "md", "svg", "txt"]);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validatePath(path: string): string | null {
  if (!path) return "empty path";
  if (path.length > 120) return "path too long";
  if (path.startsWith("/") || path.includes("\\")) return "path must be relative";
  const segments = path.split("/");
  if (segments.length > LIMITS.maxPathDepth) return "path nested too deeply";
  if (segments.some((s) => s === "." || s === ".." || !SEGMENT.test(s))) return "invalid path segment";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(ext)) return `file type .${ext} is not supported in the preview`;
  return null;
}

/** Models sometimes wrap file bodies in markdown fences despite instructions. */
export function stripCodeFence(content: string): string {
  const m = content.match(/^\s*```[\w-]*\r?\n([\s\S]*?)\r?\n```\s*$/);
  return m ? m[1] : content;
}

/**
 * Models sometimes wrap a .js/.css file in its HTML tag (or leave a stray
 * closing tag at the end), which is a syntax error once the file is inlined.
 */
export function stripWrapperTags(path: string, content: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const tag = ext === "js" ? "script" : ext === "css" ? "style" : null;
  if (!tag) return content;
  return content.replace(new RegExp(`^\\s*<${tag}\\b[^>]*>\\s*\\n?`, "i"), "").replace(new RegExp(`\\n?\\s*</${tag}>\\s*$`, "i"), "");
}

export interface ValidationResult {
  accepted: Map<string, string>;
  deletes: Set<string>;
  rejected: { path: string; reason: string }[];
  warnings: string[];
  /** Full project state after applying the accepted operations. */
  merged: Map<string, string>;
}

export function validateFileOps(existing: Map<string, string>, proposed: Map<string, string>, deletes: Set<string>): ValidationResult {
  const accepted = new Map<string, string>();
  const acceptedDeletes = new Set<string>();
  const rejected: { path: string; reason: string }[] = [];
  const warnings: string[] = [];

  for (const [path, raw] of proposed) {
    const pathError = validatePath(path);
    if (pathError) {
      rejected.push({ path, reason: pathError });
      continue;
    }
    const content = stripWrapperTags(path, stripCodeFence(raw));
    if (!content.trim()) {
      rejected.push({ path, reason: "file is empty" });
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > LIMITS.maxFileBytes) {
      rejected.push({ path, reason: `file exceeds ${LIMITS.maxFileBytes / 1000} KB` });
      continue;
    }
    accepted.set(path, content);
  }

  for (const path of deletes) {
    if (existing.has(path) && !accepted.has(path)) acceptedDeletes.add(path);
  }

  const merged = new Map(existing);
  for (const path of acceptedDeletes) merged.delete(path);
  for (const [path, content] of accepted) merged.set(path, content);

  // Project-level limits: drop the newest additions rather than failing everything.
  for (const path of [...accepted.keys()].reverse()) {
    const tooMany = merged.size > LIMITS.maxFiles;
    const tooBig = projectBytes(merged) > LIMITS.maxProjectBytes;
    if (!tooMany && !tooBig) break;
    if (!existing.has(path)) {
      merged.delete(path);
      accepted.delete(path);
      rejected.push({ path, reason: tooMany ? "project file limit reached" : "project size limit reached" });
    }
  }
  if (projectBytes(merged) > LIMITS.maxProjectBytes) {
    warnings.push("Project is close to the size limit; consider removing unused files.");
  }
  if (!merged.has("index.html")) {
    warnings.push("No index.html in the project, so the preview has nothing to render.");
  }

  return { accepted, deletes: acceptedDeletes, rejected, warnings, merged };
}

export function projectBytes(files: Map<string, string>): number {
  let total = 0;
  for (const content of files.values()) total += Buffer.byteLength(content, "utf8");
  return total;
}
