import type { Request, Response } from "express";
import { logger } from "firebase-functions";
import { requireUser } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { enforceRateLimit } from "../lib/rateLimit";
import { openSse } from "../lib/sse";
import { STALE_LOCK_MS, db, getOwnedProject, loadFiles, loadHistory, now } from "../lib/store";
import { FileStreamParser, ParseResult, ParserEvent } from "../generation/parser";
import { PROMPT_VERSION, buildMessages } from "../generation/prompt";
import { loadExternalContext } from "../generation/externalContext";
import { activeModel, streamCompletion, LlmResult } from "../generation/llm";
import { addUsage, classifyError, type GenerationFailure } from "../generation/llmErrors";
import { applyRepair, resolveEdits, type ResolvedEdits } from "../generation/resolve";
import { saveGeneration } from "../generation/save";
import { jsSyntaxErrors } from "../generation/syntax";
import { stripCodeFence, stripWrapperTags } from "../generation/validate";

const HARD_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_PROMPT_CHARS = 4000;

type AbortReason = "cancelled" | "timeout";

/**
 * POST /generate -> SSE. Lock -> stream -> parse -> edits/repair -> one atomic save.
 * A browser disconnect doesn't stop it (the tokens are paid for); only cancel or the timeout does.
 */
export async function generateHandler(req: Request, res: Response) {
  // Spends LLM credits and reads a CRM summary: cut off revoked users immediately.
  const user = await requireUser(req, { checkRevoked: true });
  const projectId = String(req.body?.projectId ?? "");
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) throw new HttpError(400, "BAD_REQUEST", "Describe what you want to build.");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new HttpError(400, "BAD_REQUEST", `Keep the request under ${MAX_PROMPT_CHARS} characters.`);
  }
  await enforceRateLimit(user.uid, "generate", 10, 10 * 60 * 1000);
  const { ref: projectRef } = await getOwnedProject(projectId, user.uid);

  // Per-project lock: a double-submit or second tab can't start two generations.
  const genRef = projectRef.collection("generations").doc();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(projectRef);
    const active = snap.get("activeGeneration") as { id: string; startedAt: number } | null;
    if (active && Date.now() - active.startedAt < STALE_LOCK_MS) {
      throw new HttpError(409, "GENERATION_IN_PROGRESS", "A generation is already running for this project.");
    }
    tx.update(projectRef, { activeGeneration: { id: genRef.id, startedAt: Date.now() } });
    tx.set(genRef, {
      uid: user.uid,
      prompt,
      model: activeModel(),
      promptVersion: PROMPT_VERSION,
      status: "running",
      cancelRequested: false,
      createdAt: now(),
    });
    tx.set(projectRef.collection("messages").doc(), {
      role: "user",
      content: prompt,
      generationId: genRef.id,
      createdAt: now(),
    });
  });

  const sse = openSse(res);
  sse.send("start", { generationId: genRef.id });

  const abort = new AbortController();
  const abortWith = (reason: AbortReason) => !abort.signal.aborted && abort.abort(reason);
  const unsubscribe = genRef.onSnapshot(
    (s) => s.get("cancelRequested") && abortWith("cancelled"),
    () => undefined,
  );
  const timeout = setTimeout(() => abortWith("timeout"), HARD_TIMEOUT_MS);

  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let parser = new FileStreamParser();
  let rawOutput = "";
  let parsed: ParseResult | null = null;
  let resolved: ResolvedEdits | null = null;
  let llmResult: LlmResult | null = null;
  let failure: GenerationFailure | null = null;

  const forward = (events: ParserEvent[]) => {
    for (const e of events) {
      if (e.type === "text") sse.send("text", { delta: e.text });
      else if (e.type === "file_start") sse.send("file_start", { path: e.path });
      else if (e.type === "file_delta") sse.send("token", { path: e.path, delta: e.text });
      else if (e.type === "file_end") sse.send("file_end", { path: e.path });
      else if (e.type === "file_delete") sse.send("file_delete", { path: e.path });
      else if (e.type === "edit_start") sse.send("edit_start", { path: e.path });
      else if (e.type === "edit_end") sse.send("edit_end", { path: e.path });
    }
  };

  try {
    const [existing, history, userSnap] = await Promise.all([
      loadFiles(projectRef),
      loadHistory(projectRef, 7),
      db().collection("users").doc(user.uid).get(),
    ]);
    const hl = userSnap.get("hl") as { status?: string; locationName?: string; locationId?: string } | undefined;
    const hlConnected = hl?.status === "connected";
    const externalContext = hlConnected ? await loadExternalContext(user.uid, hl?.locationId ?? null) : null;
    const { messages, omittedFiles } = buildMessages({
      files: existing,
      history: history.slice(0, -1), // the last entry is the prompt we just stored
      locationName: hl?.locationName ?? null,
      hlConnected,
      externalContext,
      prompt,
    });
    if (omittedFiles.length) {
      sse.send("warning", { message: `Large project: ${omittedFiles.length} file(s) were not sent to the AI.` });
    }

    llmResult = await streamCompletion(messages, abort.signal, (chunk) => {
      if (chunk.type === "restart") {
        // Server-side fallback re-ran the request on another model: discard partial output.
        parser = new FileStreamParser();
        rawOutput = "";
        sse.send("reset", {});
        return;
      }
      firstTokenAt ??= Date.now();
      rawOutput += chunk.text;
      forward(parser.feed(chunk.text));
    });

    if (llmResult.stopReason === "refusal") {
      failure = { code: "LLM_REFUSED", message: "The AI declined this request. Try rephrasing it.", retryable: false };
    } else if (llmResult.stopReason === "max_tokens") {
      sse.send("warning", { message: "The response hit the length limit; the last file may be incomplete." });
    }

    // Apply search/replace edits; if one doesn't match, ask once for the whole file.
    const finished = parser.finish();
    forward(finished.events);
    parsed = finished.result;
    resolved = resolveEdits(existing, parsed);
    for (const [path, reason] of resolved.failures) logger.warn("edit_failed", { projectId, generationId: genRef.id, path, reason });
    // A "complete rewrite" of a file the model never saw would be invented, not repaired, so those stay failed.
    const repairable = [...resolved.failures].filter(([p]) => !omittedFiles.includes(p));

    // One extra call that asks for complete corrected files; only the requested paths are taken from it.
    const requestRepair = async (paths: string[], problem: string) => {
      let repairParser = new FileStreamParser();
      const onlyFiles = (events: ParserEvent[]) => forward(events.filter((e) => e.type !== "text"));
      const repair = await streamCompletion(
        [
          ...messages,
          { role: "assistant", content: rawOutput },
          {
            role: "user",
            content: `${problem}\n\nOutput the COMPLETE corrected content of ${paths.join(", ")} using <file> tags only. No other text.`,
          },
        ],
        abort.signal,
        (chunk) => {
          if (chunk.type === "restart")
            repairParser = new FileStreamParser(); // fallback model re-ran: drop the partial answer
          else onlyFiles(repairParser.feed(chunk.text));
        },
      );
      const repaired = repairParser.finish();
      onlyFiles(repaired.events);
      llmResult = { ...llmResult!, usage: addUsage(llmResult!.usage, repair.usage) };
      return repaired.result.completed;
    };

    if (!failure && repairable.length > 0) {
      const paths = repairable.map(([p]) => p);
      sse.send("warning", { message: `A quick edit to ${paths.join(", ")} didn't match, so rewriting it in full.` });
      const files = await requestRepair(
        paths,
        `These edits could not be applied:\n${repairable.map(([p, r]) => `- ${p}: ${r}`).join("\n")}\n\nApply every change from your previous answer.`,
      );
      resolved = applyRepair(resolved, files, paths);
    }

    // A syntax error in app.js means a blank preview. Ask once for a fix; keep it only if it parses.
    // Checked after the same cleanup validation applies, so a stray fence or wrapper tag isn't sent for repair.
    const cleaned = new Map([...resolved.proposed].map(([p, c]) => [p, stripWrapperTags(p, stripCodeFence(c))]));
    const syntaxErrors = failure ? new Map<string, string>() : jsSyntaxErrors(cleaned);
    if (syntaxErrors.size > 0) {
      const paths = [...syntaxErrors.keys()];
      for (const [path, error] of syntaxErrors) logger.warn("syntax_error", { projectId, generationId: genRef.id, path, error });
      sse.send("warning", { message: `${paths.join(", ")} had a JavaScript syntax error, fixing it.` });
      const files = await requestRepair(
        paths,
        `Your code has JavaScript syntax errors:\n${[...syntaxErrors].map(([p, e]) => `- ${p}: ${e}`).join("\n")}\nA common cause is a backtick or \${...} inside the backtick template string.`,
      );
      const fixed = new Map([...files].filter(([p]) => paths.includes(p) && jsSyntaxErrors(new Map([[p, files.get(p)!]])).size === 0));
      for (const [path, content] of fixed) resolved.proposed.set(path, content);
      resolved.stats.syntaxRepaired = fixed.size;
    }
  } catch (err) {
    failure = classifyError(err, abort.signal);
    if (failure.code === "INTERNAL") logger.error("Generation failed", err);
    else
      logger.warn("generation_error", { projectId, generationId: genRef.id, code: failure.code, detail: (err as Error)?.message ?? null });
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }

  // Runs on failure too, so finished files are kept.
  if (!parsed) {
    const finished = parser.finish();
    forward(finished.events);
    parsed = finished.result;
  }
  try {
    await saveGeneration({
      sse,
      projectId,
      projectRef,
      genRef,
      prompt,
      result: parsed,
      resolved,
      failure,
      llmResult,
      startedAt,
      firstTokenAt,
    });
  } finally {
    sse.end();
  }
}

/** POST /generate/cancel { projectId, generationId } */
export async function cancelHandler(req: Request, res: Response) {
  const user = await requireUser(req);
  const { ref } = await getOwnedProject(String(req.body?.projectId ?? ""), user.uid);
  const generationId = String(req.body?.generationId ?? "");
  if (!generationId || generationId.includes("/")) throw new HttpError(400, "BAD_REQUEST", "Invalid generation id.");
  const genRef = ref.collection("generations").doc(generationId);
  const snap = await genRef.get();
  if (!snap.exists) throw new HttpError(404, "NOT_FOUND", "Generation not found.");
  if (snap.get("status") === "running") await genRef.update({ cancelRequested: true });
  res.json({ ok: true });
}
