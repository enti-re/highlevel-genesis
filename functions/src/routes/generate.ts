import type { DocumentReference } from "firebase-admin/firestore";
import type { Request, Response } from "express";
import { logger } from "firebase-functions";
import { requireUser } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { enforceRateLimit } from "../lib/rateLimit";
import { openSse } from "../lib/sse";
import { STALE_LOCK_MS, db, getOwnedProject, now } from "../lib/store";
import { loadGenerationContext } from "../generation/context";
import { FileStreamParser, ParseResult, ParserEvent } from "../generation/parser";
import { PROMPT_VERSION } from "../generation/prompt";
import { activeModel, streamCompletion, LlmResult } from "../generation/llm";
import { addUsage, classifyError, type GenerationFailure } from "../generation/llmErrors";
import { repairFailedEdits, repairSyntaxErrors, type RequestRepair } from "../generation/repair";
import { resolveEdits, type ResolvedEdits } from "../generation/resolve";
import { saveGeneration } from "../generation/save";

const HARD_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_PROMPT_CHARS = 4000;
const GENERATIONS_PER_WINDOW = 10;
const GENERATION_WINDOW_MS = 10 * 60 * 1000;

type AbortReason = "cancelled" | "timeout";
type Sse = ReturnType<typeof openSse>;

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
  await enforceRateLimit(user.uid, "generate", GENERATIONS_PER_WINDOW, GENERATION_WINDOW_MS);
  const { ref: projectRef } = await getOwnedProject(projectId, user.uid);
  const genRef = await lockProject(projectRef, user.uid, prompt);

  const sse = openSse(res);
  sse.send("start", { generationId: genRef.id });

  const abort = new AbortController();
  const abortWith = (reason: AbortReason) => !abort.signal.aborted && abort.abort(reason);
  const unsubscribe = genRef.onSnapshot(
    (generationSnap) => generationSnap.get("cancelRequested") && abortWith("cancelled"),
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
  const forward = (events: ParserEvent[]) => forwardToSse(sse, events);

  try {
    const { existing, messages, omittedFiles } = await loadGenerationContext(projectRef, user.uid, prompt);
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

    const finished = parser.finish();
    forward(finished.events);
    parsed = finished.result;
    resolved = resolveEdits(existing, parsed);

    // Continues the same conversation, so it reads the whole context from the prompt cache.
    const requestRepair: RequestRepair = async (paths, problem) => {
      let repairParser = new FileStreamParser();
      const onlyFiles = (events: ParserEvent[]) => forward(events.filter((event) => event.type !== "text"));
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
      llmResult = { ...llmResult!, usage: addUsage(llmResult!.usage, repair.usage), model: llmResult!.model ?? repair.model };
      return repaired.result.completed;
    };

    if (!failure) {
      const repairContext = {
        requestRepair,
        warn: (message: string) => sse.send("warning", { message }),
        logFields: { projectId, generationId: genRef.id },
      };
      resolved = await repairFailedEdits(resolved, omittedFiles, repairContext);
      await repairSyntaxErrors(resolved, repairContext);
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

/** Per-project lock (transaction): a double-submit or second tab can't start two generations. */
async function lockProject(projectRef: DocumentReference, uid: string, prompt: string): Promise<DocumentReference> {
  const genRef = projectRef.collection("generations").doc();
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(projectRef);
    const active = snap.get("activeGeneration") as { id: string; startedAt: number } | null;
    if (active && Date.now() - active.startedAt < STALE_LOCK_MS) {
      throw new HttpError(409, "GENERATION_IN_PROGRESS", "A generation is already running for this project.");
    }
    tx.update(projectRef, { activeGeneration: { id: genRef.id, startedAt: Date.now() } });
    tx.set(genRef, {
      uid,
      prompt,
      model: activeModel(),
      promptVersion: PROMPT_VERSION,
      status: "running",
      cancelRequested: false,
      createdAt: now(),
    });
    tx.set(projectRef.collection("messages").doc(), { role: "user", content: prompt, generationId: genRef.id, createdAt: now() });
  });
  return genRef;
}

/** Parser events -> SSE protocol events (see README). */
const SSE_EVENT: Record<ParserEvent["type"], string> = {
  text: "text",
  file_start: "file_start",
  file_delta: "token",
  file_end: "file_end",
  file_delete: "file_delete",
  edit_start: "edit_start",
  edit_end: "edit_end",
};

function forwardToSse(sse: Sse, events: ParserEvent[]) {
  for (const event of events) {
    if (event.type === "text") sse.send("text", { delta: event.text });
    else if (event.type === "file_delta") sse.send(SSE_EVENT[event.type], { path: event.path, delta: event.text });
    else sse.send(SSE_EVENT[event.type], { path: event.path });
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
