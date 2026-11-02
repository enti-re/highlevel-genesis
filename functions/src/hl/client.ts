import { logger } from "firebase-functions";
import { isMockHl } from "../config";
import { HttpError } from "../lib/errors";
import { getAccessToken } from "./tokens";
import { HL_API_BASE, HlRequest, runOperation } from "./operations";
import { mockFetch, MOCK_LOCATION_ID } from "./mock";
import { RetryableError, withRetry } from "./retry";

const REQUEST_TIMEOUT_MS = 15_000;

async function rawFetch(token: string, req: HlRequest): Promise<any> {
  const url = new URL(HL_API_BASE + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: req.version,
        Accept: "application/json",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body ? JSON.stringify(req.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    throw new HttpError(504, "HL_TIMEOUT", timedOut ? "HighLevel took too long to respond." : "Could not reach HighLevel.", true);
  }

  const body = (await res.json().catch(() => null)) as any;
  if (res.ok) return body;

  const detail = Array.isArray(body?.message) ? body.message.join("; ") : (body?.message ?? body?.error ?? res.statusText);
  logger.warn("HighLevel API error", { path: req.path, status: res.status, detail });
  if (res.status === 401) throw new HttpError(401, "HL_UNAUTHORIZED", "HighLevel rejected the access token.");
  if (res.status === 403) {
    throw new HttpError(
      403,
      "HL_FORBIDDEN",
      "The HighLevel app is missing a permission (scope) for this data. Reconnect after updating scopes.",
    );
  }
  if (res.status === 404) throw new HttpError(404, "HL_NOT_FOUND", "That HighLevel record was not found.");
  if (res.status === 429) {
    const err: RetryableError = new HttpError(429, "HL_RATE_LIMITED", "HighLevel rate limit reached. Please wait a moment.", true);
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
    throw err;
  }
  if (res.status >= 500) throw new HttpError(502, "HL_UNAVAILABLE", "HighLevel is having trouble right now.", true);
  throw new HttpError(res.status === 422 ? 422 : 400, "HL_BAD_REQUEST", `HighLevel rejected the request: ${String(detail).slice(0, 200)}`);
}

/** Runs a whitelisted operation for a user: transient errors retried with backoff, token refreshed once on 401. */
export async function callHl(uid: string, op: string, params: Record<string, unknown>) {
  if (isMockHl()) return runOperation(op, params, { locationId: MOCK_LOCATION_ID, fetch: mockFetch });

  let { token, locationId } = await getAccessToken(uid);
  const fetchWithRetry = async (req: HlRequest) => {
    try {
      // Transient failures (429/5xx/timeout) back off with jitter; reads only.
      return await withRetry(req, () => rawFetch(token, req));
    } catch (err) {
      if (!(err instanceof HttpError) || err.code !== "HL_UNAUTHORIZED") throw err;
      // Token was revoked/rotated early - force one refresh, then retry once.
      ({ token, locationId } = await getAccessToken(uid, token));
      return rawFetch(token, req);
    }
  };
  return runOperation(op, params, { locationId, fetch: fetchWithRetry });
}

/** Best-effort location name for the dashboard; never blocks the OAuth flow. */
export async function fetchLocationName(token: string, locationId: string): Promise<string | null> {
  try {
    const data = await rawFetch(token, { method: "GET", path: `/locations/${locationId}`, version: "2021-07-28" });
    return data?.location?.name ?? null;
  } catch {
    return null;
  }
}
