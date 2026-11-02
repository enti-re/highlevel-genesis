/** Shared types and constants for the HighLevel client and operations. */

export const HL_API_BASE = "https://services.leadconnectorhq.com";
export const V_CONTACTS = "2021-07-28";
export const V_CONVERSATIONS = "2021-04-15";
export const V_CALENDARS = "2021-04-15";
export const V_LOCATIONS = "2021-07-28";

export interface HlRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  version: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
}

/** Executes one raw HighLevel request (injected so operations stay testable). */
export type HlFetch = (req: HlRequest) => Promise<any>;

export interface OpContext {
  locationId: string;
  fetch: HlFetch;
}

export type Params = Record<string, unknown>;
export type Operation = (params: Params, ctx: OpContext) => Promise<unknown>;
