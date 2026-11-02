import { HttpError } from "../lib/errors";
import type { Params } from "./types";

/** Param validation for operations: ids are interpolated into URL paths, so they are checked strictly. */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function id(params: Params, key: string): string {
  const v = params[key];
  if (typeof v !== "string" || !ID_RE.test(v)) throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" must be a valid id`);
  return v;
}
export function optStr(params: Params, key: string, max = 200): string | undefined {
  const v = params[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" must be a string`);
  return v.slice(0, max);
}
export function int(params: Params, key: string, min: number, max: number, fallback: number): number {
  const v = Number(params[key] ?? fallback);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
/** Accepts ms epoch, ISO strings or Date-like values; returns ms epoch. */
export function time(params: Params, key: string, fallback?: number): number {
  const raw = params[key];
  if (raw === undefined || raw === null || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" is required`);
  }
  const ms = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(ms)) throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" must be a date`);
  return ms;
}

const CONTACT_WRITE_FIELDS = [
  "firstName",
  "lastName",
  "name",
  "email",
  "phone",
  "companyName",
  "address1",
  "city",
  "state",
  "postalCode",
  "country",
  "website",
  "source",
  "tags",
  "timezone",
] as const;

export function contactBody(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new HttpError(400, "HL_BAD_PARAMS", '"contact" must be an object');
  const body: Record<string, unknown> = {};
  for (const field of CONTACT_WRITE_FIELDS) {
    const v = (input as Record<string, unknown>)[field];
    if (v === undefined) continue;
    if (field === "tags") {
      if (!Array.isArray(v)) throw new HttpError(400, "HL_BAD_PARAMS", '"tags" must be an array of strings');
      body.tags = v.map(String).slice(0, 20);
    } else {
      body[field] = String(v).slice(0, 300);
    }
  }
  return body;
}
