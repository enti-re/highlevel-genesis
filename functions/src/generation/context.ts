import type { DocumentReference } from "firebase-admin/firestore";
import { db, loadFiles, loadHistory } from "../lib/store";
import { loadExternalContext } from "./externalContext";
import { buildMessages } from "./prompt";

/** The 6 messages prompt.ts sends plus the prompt just stored (dropped below). */
const HISTORY_TO_LOAD = 7;

/** Everything the model sees for one generation: current files, recent chat, the HighLevel account summary. */
export async function loadGenerationContext(projectRef: DocumentReference, uid: string, prompt: string) {
  const [existing, history, userSnap] = await Promise.all([
    loadFiles(projectRef),
    loadHistory(projectRef, HISTORY_TO_LOAD),
    db().collection("users").doc(uid).get(),
  ]);
  const hl = userSnap.get("hl") as { status?: string; locationName?: string; locationId?: string } | undefined;
  const hlConnected = hl?.status === "connected";
  const externalContext = hlConnected ? await loadExternalContext(uid, hl?.locationId ?? null) : null;
  const { messages, omittedFiles } = buildMessages({
    files: existing,
    history: history.slice(0, -1), // the last entry is the prompt we just stored
    locationName: hl?.locationName ?? null,
    hlConnected,
    externalContext,
    prompt,
  });
  return { existing, messages, omittedFiles };
}
