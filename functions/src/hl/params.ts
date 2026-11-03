import { HttpError } from "../lib/errors";
import type { Params } from "./types";

/** Param validation for operations: ids are interpolated into URL paths, so they are checked strictly. */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_MAX_CHARS = 200;
const MAX_TAGS = 20;
const MAX_FIELD_CHARS = 300;

export function id(params: Params, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !ID_RE.test(value)) throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" must be a valid id`);
  return value;
}
export function optStr(params: Params, key: string, max = DEFAULT_MAX_CHARS): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, "HL_BAD_PARAMS", `"${key}" must be a string`);
  return value.slice(0, max);
}
export function int(params: Params, key: string, min: number, max: number, fallback: number): number {
  const value = Number(params[key] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
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
    const value = (input as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (field === "tags") {
      if (!Array.isArray(value)) throw new HttpError(400, "HL_BAD_PARAMS", '"tags" must be an array of strings');
      body.tags = value.map(String).slice(0, MAX_TAGS);
    } else {
      body[field] = String(value).slice(0, MAX_FIELD_CHARS);
    }
  }
  return body;
}
