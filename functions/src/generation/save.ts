import type { DocumentReference } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import type { openSse } from "../lib/sse";
import { captureManualEdits, db, fileDocId, loadFiles, now } from "../lib/store";
import { scoreConfidence } from "./confidence";
import type { LlmResult } from "./llm";
import type { GenerationFailure } from "./llmErrors";
import type { ParseResult } from "./parser";
import { resolveEdits, type ResolvedEdits } from "./resolve";
import { validateFileOps } from "./validate";

export type GenerationStatus = "complete" | "no_changes" | "partial" | "failed" | "cancelled" | "cancelled_partial";

/** Whether anything was saved decides between e.g. "partial" (keep finished files) and "failed". */
export function deriveStatus(failure: GenerationFailure | null, changed: number): GenerationStatus {
  if (!failure) return changed ? "complete" : "no_changes";
  if (failure.code === "CANCELLED") return changed ? "cancelled_partial" : "cancelled";
  return changed ? "partial" : "failed";
}

export interface SaveInput {
  sse: ReturnType<typeof openSse>;
  projectId: string;
  projectRef: DocumentReference;
  genRef: DocumentReference;
  prompt: string;
  result: ParseResult;
  resolved: ResolvedEdits | null;
  failure: GenerationFailure | null;
  llmResult: LlmResult | null;
  startedAt: number;
  firstTokenAt: number | null;
}

/** One batch: files + snapshot + message + generation + unlock. Sends the final SSE event. */
export async function saveGeneration(input: SaveInput): Promise<void> {
  const { sse, projectId, projectRef, genRef, prompt, result, llmResult } = input;
  let failure = input.failure;
  try {
    const existing = await loadFiles(projectRef);
    const { proposed, stats: editStats, failures } = input.resolved ?? resolveEdits(existing, result);
    const validation = validateFileOps(existing, proposed, result.deleted);
    const warnings = [...[...failures].map(([p, r]) => `Skipped a change to "${p}": ${r}.`), ...validation.warnings];
    if (result.incomplete) warnings.push(`"${result.incomplete.path}" was cut off and was not saved.`);
    for (const r of validation.rejected) warnings.push(`Skipped "${r.path}": ${r.reason}.`);

    const changed = validation.accepted.size + validation.deletes.size;
    if (!failure && changed === 0 && failures.size > 0) {
      failure = {
        code: "EDIT_FAILED",
        message: "The AI's change couldn't be applied to the current code, so nothing was changed. Please try again.",
        retryable: true,
      };
    }
    if (failure && changed === 0) failure.message = failure.message.replace(/\s*Finished files were kept\.$/, "");
    const status = deriveStatus(failure, changed);

    const batch = db().batch();
    let snapshotId: string | null = null;
    if (changed > 0) {
      const snapshotTime = await captureManualEdits(projectRef, existing, batch);
      for (const [path, content] of validation.accepted) {
        batch.set(projectRef.collection("files").doc(fileDocId(path)), { path, content, updatedBy: "ai", updatedAt: now() });
      }
      for (const path of validation.deletes) batch.delete(projectRef.collection("files").doc(fileDocId(path)));
      const snapRef = projectRef.collection("snapshots").doc();
      snapshotId = snapRef.id;
      batch.set(snapRef, {
        createdAt: snapshotTime,
        generationId: genRef.id,
        prompt,
        status: status === "complete" ? "complete" : "partial",
        label: status === "complete" ? "AI generation" : "AI generation (partial)",
        files: [...validation.merged].map(([path, content]) => ({ path, content })),
      });
    }

    const confidence = scoreConfidence({ status, files: validation.merged, warnings, incomplete: !!result.incomplete, edits: editStats });
    const assistantText =
      result.text || (failure ? "" : changed ? "Done. The preview has been updated." : "I didn't change any files for this request.");
    batch.set(projectRef.collection("messages").doc(), {
      role: "assistant",
      content: assistantText,
      generationId: genRef.id,
      status,
      files: [...validation.accepted.keys()],
      deletedFiles: [...validation.deletes],
      warnings,
      error: failure,
      snapshotId,
      confidence,
      createdAt: now(),
    });
    // Latency metrics: time-to-first-token is what users feel; duration drives cost and timeouts.
    const metrics = {
      ttftMs: input.firstTokenAt ? input.firstTokenAt - input.startedAt : null,
      durationMs: Date.now() - input.startedAt,
      edits: editStats,
    };
    const usage = llmResult?.usage ?? null;
    logger.info("generation_finished", {
      projectId,
      generationId: genRef.id,
      status,
      errorCode: failure?.code ?? null,
      files: changed,
      ...metrics,
      usage,
      confidence: confidence.score,
    });
    batch.update(genRef, { status, finishedAt: now(), error: failure, snapshotId, usage, warnings, metrics, confidence });
    batch.update(projectRef, { activeGeneration: null, updatedAt: now() });
    await batch.commit();

    const files = [...validation.accepted.keys()];
    if (failure) sse.send("error", { ...failure, status, savedFiles: files, snapshotId, warnings, confidence });
    else sse.send("done", { status, snapshotId, files, deleted: [...validation.deletes], warnings, confidence });
  } catch (err) {
    logger.error("Failed to save generation", err);
    // Release the lock even if the save failed, so the project isn't stuck.
    await projectRef.update({ activeGeneration: null }).catch(() => undefined);
    await genRef.update({ status: "failed", finishedAt: now() }).catch(() => undefined);
    sse.send("error", {
      code: "SAVE_FAILED",
      message: "We couldn't save the generated files. Please try again.",
      retryable: true,
      savedFiles: [],
    });
  }
}
