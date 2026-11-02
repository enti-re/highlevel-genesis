/**
 * Incremental parser for the LLM output contract:
 *
 *   free text (shown in chat)
 *   <file path="index.html">
 *   ...full file content...
 *   </file>
 *   <edit path="app.js"><search>..</search><replace>..</replace></edit>
 *   <delete path="old.js"/>
 *
 * Tags can arrive split across stream chunks, so anything that might be the
 * start of a tag is held back until the next chunk disambiguates it.
 */

export type ParserEvent =
  | { type: "text"; text: string }
  | { type: "file_start"; path: string }
  | { type: "file_delta"; path: string; text: string }
  | { type: "file_end"; path: string; content: string }
  | { type: "file_delete"; path: string }
  | { type: "edit_start"; path: string }
  | { type: "edit_end"; path: string };

export interface ParseResult {
  /** Files whose closing tag arrived. Later writes to the same path win. */
  completed: Map<string, string>;
  deleted: Set<string>;
  /** Search/replace edits in output order, applied after `completed` (see edits.ts). */
  edits: { path: string; body: string }[];
  /** A file or edit that was still open when the stream ended (truncated/aborted). */
  incomplete: { path: string; content: string } | null;
  /** Free text outside file tags - becomes the assistant chat message. */
  text: string;
}

const FILE_OPEN = '<file path="';
const DELETE_OPEN = '<delete path="';
const FILE_CLOSE = "</file>";
const EDIT_OPEN = '<edit path="';
const EDIT_CLOSE = "</edit>";
const MAX_TAG_LENGTH = 300;

/** Length of the longest suffix of `s` that is a prefix of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(s.slice(s.length - len))) return len;
  }
  return 0;
}

export class FileStreamParser {
  private buffer = "";
  private currentPath: string | null = null;
  private currentKind: "file" | "edit" = "file";
  private currentContent = "";
  private dropLeadingNewline = false;
  private result: ParseResult = {
    completed: new Map(),
    deleted: new Set(),
    edits: [],
    incomplete: null,
    text: "",
  };

  feed(chunk: string): ParserEvent[] {
    this.buffer += chunk;
    const events: ParserEvent[] = [];
    let progressed = true;
    while (progressed) {
      progressed = this.currentPath === null ? this.scanOutside(events) : this.scanInside(events);
    }
    return events;
  }

  /** Call once the stream has ended (normally or not). */
  finish(): { events: ParserEvent[]; result: ParseResult } {
    const events: ParserEvent[] = [];
    if (this.currentPath !== null) {
      // Stream ended mid-file/edit: keep what we have but flag it as incomplete.
      this.currentContent += this.buffer;
      this.result.incomplete = { path: this.currentPath, content: this.currentContent };
    } else if (this.buffer) {
      this.emitText(this.buffer, events);
    }
    this.buffer = "";
    // Newlines between file tags pile up in the chat text; collapse them.
    this.result.text = this.result.text.replace(/\n{3,}/g, "\n\n").trim();
    return { events, result: this.result };
  }

  private emitText(text: string, events: ParserEvent[]) {
    if (!text) return;
    this.result.text += text;
    events.push({ type: "text", text });
  }

  private scanOutside(events: ParserEvent[]): boolean {
    const fileIdx = this.buffer.indexOf(FILE_OPEN);
    const editIdx = this.buffer.indexOf(EDIT_OPEN);
    const delIdx = this.buffer.indexOf(DELETE_OPEN);
    const candidates = [fileIdx, editIdx, delIdx].filter((i) => i >= 0);

    if (candidates.length === 0) {
      // No tag yet - flush everything except a possible partial tag at the end.
      const hold = Math.max(
        partialTagSuffix(this.buffer, FILE_OPEN),
        partialTagSuffix(this.buffer, EDIT_OPEN),
        partialTagSuffix(this.buffer, DELETE_OPEN),
      );
      this.emitText(this.buffer.slice(0, this.buffer.length - hold), events);
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return false;
    }

    const idx = Math.min(...candidates);
    const kind = idx === fileIdx ? "file" : idx === editIdx ? "edit" : "delete";
    const open = kind === "file" ? FILE_OPEN : kind === "edit" ? EDIT_OPEN : DELETE_OPEN;
    const tagEnd = this.buffer.indexOf(">", idx);
    if (tagEnd === -1) {
      if (this.buffer.length - idx > MAX_TAG_LENGTH) {
        // Not a real tag (or a broken one) - treat as text so we never stall.
        this.emitText(this.buffer.slice(0, idx + open.length), events);
        this.buffer = this.buffer.slice(idx + open.length);
        return true;
      }
      this.emitText(this.buffer.slice(0, idx), events);
      this.buffer = this.buffer.slice(idx);
      return false; // wait for the rest of the tag
    }

    this.emitText(this.buffer.slice(0, idx), events);
    const tag = this.buffer.slice(idx, tagEnd + 1);
    this.buffer = this.buffer.slice(tagEnd + 1);
    const quoteEnd = tag.indexOf('"', open.length);
    const path = quoteEnd === -1 ? "" : tag.slice(open.length, quoteEnd).trim();

    if (kind !== "delete") {
      this.currentPath = path;
      this.currentKind = kind;
      this.currentContent = "";
      this.dropLeadingNewline = true;
      events.push({ type: kind === "file" ? "file_start" : "edit_start", path });
    } else {
      this.result.deleted.add(path);
      this.result.completed.delete(path);
      this.result.edits = this.result.edits.filter((e) => e.path !== path);
      events.push({ type: "file_delete", path });
    }
    return true;
  }

  private scanInside(events: ParserEvent[]): boolean {
    const path = this.currentPath as string;
    if (this.dropLeadingNewline && this.buffer.length > 0) {
      if (this.buffer.startsWith("\r\n")) this.buffer = this.buffer.slice(2);
      else if (this.buffer.startsWith("\n")) this.buffer = this.buffer.slice(1);
      this.dropLeadingNewline = false;
    }

    const isEdit = this.currentKind === "edit";
    const close = isEdit ? EDIT_CLOSE : FILE_CLOSE;
    const closeIdx = this.buffer.indexOf(close);
    if (closeIdx === -1) {
      const hold = partialTagSuffix(this.buffer, close);
      const text = this.buffer.slice(0, this.buffer.length - hold);
      if (text) {
        this.currentContent += text;
        // Edit bodies are search/replace markup, not file content: don't stream them into the editor.
        if (!isEdit) events.push({ type: "file_delta", path, text });
      }
      this.buffer = this.buffer.slice(this.buffer.length - hold);
      return false;
    }

    const text = this.buffer.slice(0, closeIdx);
    if (text) {
      this.currentContent += text;
      if (!isEdit) events.push({ type: "file_delta", path, text });
    }
    this.buffer = this.buffer.slice(closeIdx + close.length);
    const content = this.currentContent.replace(/\r?\n$/, "");
    if (isEdit) {
      this.result.edits.push({ path, body: content });
      events.push({ type: "edit_end", path });
    } else {
      this.result.completed.set(path, content);
      this.result.deleted.delete(path);
      // A full rewrite supersedes earlier edits to the same file.
      this.result.edits = this.result.edits.filter((e) => e.path !== path);
      events.push({ type: "file_end", path, content });
    }
    this.currentPath = null;
    this.currentContent = "";
    return true;
  }
}
