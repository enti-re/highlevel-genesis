import type { Request, Response } from "express";
import { requireUser } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { STALE_LOCK_MS, captureManualEdits, db, fileDocId, getOwnedProject, loadFiles, now } from "../lib/store";

/**
 * POST /projects/:projectId/snapshots/:snapshotId/restore
 *
 * Restoring is itself recorded as a new snapshot, so a restore can be undone
 * by restoring the snapshot taken just before it. Blocked while a generation
 * is running, otherwise the generation's commit would overwrite the restore.
 */
export async function restoreHandler(req: Request, res: Response) {
  const user = await requireUser(req);
  const { ref, data } = await getOwnedProject(String(req.params.projectId), user.uid);
  const active = data.activeGeneration;
  if (active && Date.now() - active.startedAt < STALE_LOCK_MS) {
    throw new HttpError(409, "GENERATION_IN_PROGRESS", "Wait for the current generation to finish before restoring.");
  }
  const snapshotId = String(req.params.snapshotId ?? "");
  if (!snapshotId || snapshotId.includes("/")) throw new HttpError(400, "BAD_REQUEST", "Invalid snapshot id.");
  const snap = await ref.collection("snapshots").doc(snapshotId).get();
  if (!snap.exists) throw new HttpError(404, "NOT_FOUND", "Snapshot not found.");

  const target = new Map<string, string>((snap.get("files") as { path: string; content: string }[]).map((f) => [f.path, f.content]));
  const current = await loadFiles(ref);

  const batch = db().batch();
  const snapshotTime = await captureManualEdits(ref, current, batch);
  for (const path of current.keys()) {
    if (!target.has(path)) batch.delete(ref.collection("files").doc(fileDocId(path)));
  }
  for (const [path, content] of target) {
    if (current.get(path) !== content) {
      batch.set(ref.collection("files").doc(fileDocId(path)), { path, content, updatedBy: "restore", updatedAt: now() });
    }
  }
  const restoredAt = snap.get("createdAt")?.toDate?.() as Date | undefined;
  const newSnap = ref.collection("snapshots").doc();
  batch.set(newSnap, {
    createdAt: snapshotTime,
    status: "complete",
    label: "Restored version",
    restoredFrom: snapshotId,
    prompt: snap.get("prompt") ?? null,
    files: [...target].map(([path, content]) => ({ path, content })),
  });
  batch.set(ref.collection("messages").doc(), {
    role: "system",
    content: `Restored the version from ${restoredAt ? restoredAt.toISOString() : "an earlier snapshot"}.`,
    snapshotId: newSnap.id,
    createdAt: now(),
  });
  batch.update(ref, { updatedAt: now() });
  await batch.commit();
  res.json({ ok: true, snapshotId: newSnap.id });
}
