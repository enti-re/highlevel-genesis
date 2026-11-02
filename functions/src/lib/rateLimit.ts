import { getFirestore } from "firebase-admin/firestore";
import { HttpError } from "./errors";

/** Fixed-window limit in a transaction, so concurrent requests can't both slip under it. */
export async function enforceRateLimit(uid: string, bucket: string, limit: number, windowMs: number) {
  const db = getFirestore();
  const ref = db.collection("rateLimits").doc(`${uid}_${bucket}`);
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const now = Date.now();
    const data = snap.data() as { windowStart: number; count: number } | undefined;
    if (!data || now - data.windowStart >= windowMs) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (data.count >= limit) return false;
    tx.update(ref, { count: data.count + 1 });
    return true;
  });
  if (!allowed) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please wait a minute and try again.", true);
  }
}
