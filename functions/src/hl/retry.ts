import { HttpError } from "../lib/errors";
import type { HlRequest } from "./operations";

/**
 * Transient HighLevel failures (429/5xx/timeout): exponential backoff with full jitter, Retry-After wins.
 * Reads only: retrying a create or sendMessage could duplicate it.
 */
export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const HL_RETRY: RetryOptions = { retries: 2, baseMs: 300, maxMs: 4000 };

export const isRepeatable = (req: HlRequest) => req.method === "GET" || req.path.endsWith("/search");

/** Set by the HTTP layer when HighLevel sends a Retry-After header. */
export type RetryableError = HttpError & { retryAfterMs?: number };

export async function withRetry<T>(req: HlRequest, fn: () => Promise<T>, opts: RetryOptions = HL_RETRY): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const error = err as RetryableError;
      const transient = error instanceof HttpError && error.retryable;
      if (!transient || !isRepeatable(req) || attempt >= opts.retries) throw err;
      const backoff = Math.min(opts.maxMs, opts.baseMs * 2 ** attempt) * random();
      await sleep(Math.min(opts.maxMs, error.retryAfterMs ?? backoff));
    }
  }
}

/** Runs fn over items with at most `limit` in flight (HighLevel's burst limit is per location). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
