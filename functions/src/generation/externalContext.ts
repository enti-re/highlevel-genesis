import { callHl } from "../hl/client";

/**
 * PII-free summary of the HighLevel account (calendar names, tags, counts) so the
 * model builds against real names. Best-effort and time-boxed: never blocks a generation.
 */

const TIMEOUT_MS = 4000;
const MAX_CALENDARS = 10;
const MAX_TAGS = 12;

type Settled<T> = PromiseSettledResult<T>;
interface LocationData {
  location?: { name?: string | null; timezone?: string | null };
}
interface CalendarsData {
  calendars?: { id: string; name?: string | null; isActive?: boolean }[];
}
interface ContactsData {
  contacts?: { tags?: string[] }[];
  total?: number;
}

const value = <T>(r: Settled<T>): T | null => (r.status === "fulfilled" ? r.value : null);

/**
 * CRM values (tags, calendar and location names) are written by anyone who can edit the account,
 * so they are untrusted: one line, no markup, short, and quoted so they read as data, not instructions.
 */
export function crmLabel(raw: unknown, max = 60): string {
  const clean = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f<>`]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return JSON.stringify(clean);
}

export function summarizeExternalContext(
  location: Settled<LocationData>,
  calendars: Settled<CalendarsData>,
  contacts: Settled<ContactsData>,
): string | null {
  const lines: string[] = [];

  const loc = value(location)?.location;
  if (loc?.name || loc?.timezone) {
    lines.push(`Location: ${crmLabel(loc.name ?? "unnamed")}${loc.timezone ? ` (timezone ${crmLabel(loc.timezone, 40)})` : ""}`);
  }

  const cals = value(calendars)?.calendars;
  if (cals) {
    const listed = cals
      .slice(0, MAX_CALENDARS)
      .map((c) => `${crmLabel(c.name ?? "Calendar")} (id ${crmLabel(c.id, 40)}${c.isActive === false ? ", inactive" : ""})`);
    lines.push(cals.length ? `Calendars (${cals.length}): ${listed.join(", ")}` : "Calendars: none yet");
  }

  const ct = value(contacts);
  if (ct) {
    const counts = new Map<string, number>();
    for (const c of ct.contacts ?? []) for (const t of c.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    const tags = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TAGS)
      .map(([t]) => crmLabel(t, 40));
    lines.push(`Contacts: about ${ct.total ?? ct.contacts?.length ?? 0} total`);
    if (tags.length) lines.push(`Common contact tags: ${tags.join(", ")}`);
  }

  if (!lines.length) return null;
  return [...lines, "(Summary only. The app must load live data at runtime through window.hl.)"].join("\n");
}

/** Per-instance cache: iterative prompts arrive seconds apart, and calendar names and tags rarely change. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; text: string | null }>();

export async function loadExternalContext(uid: string, locationId: string | null): Promise<string | null> {
  // Keyed by location too, so switching sub-accounts never reuses another location's summary.
  const key = `${uid}:${locationId ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;
  const text = await fetchExternalContext(uid);
  cache.set(key, { at: Date.now(), text });
  return text;
}

async function fetchExternalContext(uid: string): Promise<string | null> {
  const timed = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS))]);
  const [location, calendars, contacts] = await Promise.allSettled([
    timed(callHl(uid, "location.get", {}) as Promise<LocationData>),
    timed(callHl(uid, "calendars.list", {}) as Promise<CalendarsData>),
    timed(callHl(uid, "contacts.list", { limit: 50 }) as Promise<ContactsData>),
  ]);
  return summarizeExternalContext(location, calendars, contacts);
}
