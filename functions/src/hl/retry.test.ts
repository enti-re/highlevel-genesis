import { describe, expect, it } from "vitest";
import { HttpError } from "../lib/errors";
import type { HlRequest } from "./operations";
import { mapLimit, withRetry } from "./retry";

const GET: HlRequest = { method: "GET", path: "/calendars/", version: "v" };
const SEARCH: HlRequest = { method: "POST", path: "/contacts/search", version: "v" };
const CREATE: HlRequest = { method: "POST", path: "/contacts/", version: "v" };
const rateLimited = () => new HttpError(429, "HL_RATE_LIMITED", "slow down", true);

function flaky(failures: number, err = rateLimited) {
  let calls = 0;
  return { fn: async () => (++calls <= failures ? Promise.reject(err()) : "ok"), calls: () => calls };
}

describe("withRetry", () => {
  const waits: number[] = [];
  const opts = { retries: 2, baseMs: 100, maxMs: 1000, sleep: async (ms: number) => void waits.push(ms), random: () => 0.5 };

  it("retries a transient failure on a read, with jittered exponential backoff", async () => {
    waits.length = 0;
    const f = flaky(2);
    await expect(withRetry(GET, f.fn, opts)).resolves.toBe("ok");
    expect(f.calls()).toBe(3);
    expect(waits).toEqual([50, 100]); // 100*2^0*0.5, 100*2^1*0.5
  });

  it("treats search POSTs as repeatable", async () => {
    const f = flaky(1);
    await expect(withRetry(SEARCH, f.fn, opts)).resolves.toBe("ok");
  });

  it("never retries a write (could duplicate a contact or SMS)", async () => {
    const f = flaky(1);
    await expect(withRetry(CREATE, f.fn, opts)).rejects.toMatchObject({ code: "HL_RATE_LIMITED" });
    expect(f.calls()).toBe(1);
  });

  it("does not retry non-transient errors", async () => {
    const f = flaky(1, () => new HttpError(404, "HL_NOT_FOUND", "nope"));
    await expect(withRetry(GET, f.fn, opts)).rejects.toMatchObject({ code: "HL_NOT_FOUND" });
    expect(f.calls()).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    const f = flaky(5);
    await expect(withRetry(GET, f.fn, opts)).rejects.toMatchObject({ code: "HL_RATE_LIMITED" });
    expect(f.calls()).toBe(3);
  });

  it("honours Retry-After (capped)", async () => {
    waits.length = 0;
    const f = flaky(1, () => Object.assign(rateLimited(), { retryAfterMs: 5000 }));
    await withRetry(GET, f.fn, opts);
    expect(waits).toEqual([1000]);
  });
});

describe("mapLimit", () => {
  it("keeps order and never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });
});
