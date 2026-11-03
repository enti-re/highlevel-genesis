import { DocumentReference, FieldValue, Timestamp, WriteBatch, getFirestore } from "firebase-admin/firestore";
import { HttpError } from "./errors";

export const db = () => getFirestore();
export const projectRef = (projectId: string) => db().collection("projects").doc(projectId);
/** File doc ids are the URL-encoded path, so "components/list.js" never creates a sub-path. */
export const fileDocId = (path: string) => encodeURIComponent(path);

/** A generation holding the project lock longer than this is assumed dead (function timeout is 9 min). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

export interface ProjectDoc {
  ownerId: string;
  name: string;
  description?: string;
  locationId?: string | null;
  deleted?: boolean;
  activeGeneration?: { id: string; startedAt: number } | null;
  snapshotCount?: number;
}

export async function getOwnedProject(projectId: string, uid: string): Promise<{ ref: DocumentReference; data: ProjectDoc }> {
  if (!projectId || typeof projectId !== "string" || projectId.includes("/")) {
    throw new HttpError(400, "BAD_REQUEST", "Invalid project id.");
  }
  const ref = projectRef(projectId);
  const snap = await ref.get();
  const data = snap.data() as ProjectDoc | undefined;
  // Same response for "missing" and "not yours" so ids can't be probed.
  if (!data || data.ownerId !== uid || data.deleted) throw new HttpError(404, "NOT_FOUND", "Project not found.");
  return { ref, data };
}

export async function loadFiles(ref: DocumentReference): Promise<Map<string, string>> {
  const snap = await ref.collection("files").get();
  return new Map(snap.docs.map((fileDoc) => [fileDoc.get("path") as string, fileDoc.get("content") as string]));
}

export async function loadHistory(ref: DocumentReference, limit: number) {
  const snap = await ref.collection("messages").orderBy("createdAt", "desc").limit(limit).get();
  return snap.docs
    .reverse()
    .map((messageDoc) => messageDoc.data())
    .filter((message) => (message.role === "user" || message.role === "assistant") && typeof message.content === "string" && message.content.trim())
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content as string }));
}

export const now = () => FieldValue.serverTimestamp();

/**
 * Snapshots unsaved-to-history manual edits before a generation or restore overwrites them.
 * Returns the timestamp for the snapshot that follows, to keep ordering.
 */
export async function captureManualEdits(
  ref: DocumentReference,
  current: Map<string, string>,
  batch: WriteBatch,
): Promise<Timestamp> {
  const latest = await ref.collection("snapshots").orderBy("createdAt", "desc").limit(1).get();
  const last = new Map<string, string>(
    ((latest.docs[0]?.get("files") ?? []) as { path: string; content: string }[]).map((file) => [file.path, file.content]),
  );
  const differs = last.size !== current.size || [...current].some(([filePath, fileContent]) => last.get(filePath) !== fileContent);
  const ts = Timestamp.now();
  if (differs && current.size > 0) {
    batch.set(ref.collection("snapshots").doc(), {
      createdAt: Timestamp.fromMillis(ts.toMillis() - 1),
      status: "complete",
      label: "Manual edits",
      prompt: null,
      files: [...current].map(([path, content]) => ({ path, content })),
    });
  }
  return ts;
}
