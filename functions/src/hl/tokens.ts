/**
 * HighLevel OAuth. Refresh tokens are single-use, so refresh runs under a Firestore
 * lease: one request refreshes, concurrent ones wait and re-read.
 */

import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { HL_CLIENT_ID, HL_CLIENT_SECRET, oauthRedirectUri, secretValue } from "../config";
import { HttpError } from "../lib/errors";
import { HL_API_BASE } from "./operations";

export const HL_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "conversations.readonly",
  "conversations.write",
  "conversations/message.readonly",
  "conversations/message.write",
  "calendars.readonly",
  "calendars/events.readonly",
  "locations.readonly",
];

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LEASE_MS = 20_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
/** While another request holds the refresh lease, wait with a growing pause, then re-read. */
const REFRESH_WAIT_ATTEMPTS = 8;
const REFRESH_WAIT_BASE_MS = 500;
const REFRESH_WAIT_STEP_MS = 250;

export interface HlConnection {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  locationId: string;
  companyId?: string | null;
  scope?: string;
  refreshLeaseUntil?: number;
}

const connectionRef = (uid: string) => getFirestore().collection("hlConnections").doc(uid);
const userRef = (uid: string) => getFirestore().collection("users").doc(uid);

export function buildAuthorizeUrl(state: string): string {
  const url = new URL("https://marketplace.gohighlevel.com/oauth/chooselocation");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", oauthRedirectUri());
  url.searchParams.set("client_id", HL_CLIENT_ID.value());
  url.searchParams.set("scope", HL_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  userType?: string;
  locationId?: string;
  companyId?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${HL_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: HL_CLIENT_ID.value(),
      client_secret: secretValue(HL_CLIENT_SECRET),
      user_type: "Location",
      redirect_uri: oauthRedirectUri(),
      ...params,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    logger.warn("HighLevel token request failed", { status: res.status, error: body?.error, message: body?.message });
    const invalidGrant = res.status === 400 || res.status === 401;
    throw new HttpError(
      invalidGrant ? 401 : 502,
      invalidGrant ? "HL_RECONNECT" : "HL_UNAVAILABLE",
      invalidGrant ? "Your HighLevel connection expired. Please reconnect." : "HighLevel is not responding. Try again shortly.",
      !invalidGrant,
    );
  }
  return body as TokenResponse;
}

export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code });
}

export async function saveConnection(uid: string, tokens: TokenResponse, locationName: string | null) {
  if (!tokens.locationId) {
    throw new HttpError(400, "HL_NEEDS_LOCATION", "Please choose a sub-account (location) when connecting HighLevel.");
  }
  const batch = getFirestore().batch();
  batch.set(connectionRef(uid), {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    locationId: tokens.locationId,
    companyId: tokens.companyId ?? null,
    scope: tokens.scope ?? "",
    refreshLeaseUntil: 0,
  } satisfies HlConnection);
  batch.set(
    userRef(uid),
    { hl: { status: "connected", locationId: tokens.locationId, locationName, connectedAt: FieldValue.serverTimestamp() } },
    { merge: true },
  );
  await batch.commit();
}

export async function markDisconnected(uid: string, status: "disconnected" | "expired") {
  const batch = getFirestore().batch();
  batch.delete(connectionRef(uid));
  batch.set(userRef(uid), { hl: { status, locationId: null, locationName: null } }, { merge: true });
  await batch.commit();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Returns a usable access token. `staleToken` is a token HighLevel just
 * rejected with 401 - it forces a refresh even if it hasn't expired yet.
 */
export async function getAccessToken(uid: string, staleToken?: string): Promise<{ token: string; locationId: string }> {
  const ref = connectionRef(uid);
  const db = getFirestore();

  for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt++) {
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(409, "HL_NOT_CONNECTED", "Connect your HighLevel account to load data.");
    const current = snap.data() as HlConnection;
    const isUsable = (connection: HlConnection) =>
      connection.accessToken !== staleToken && connection.expiresAt - Date.now() > REFRESH_MARGIN_MS;
    if (isUsable(current)) return { token: current.accessToken, locationId: current.locationId };

    const lease = await db.runTransaction(async (tx) => {
      const txSnap = await tx.get(ref);
      const latest = txSnap.data() as HlConnection | undefined;
      if (!latest) return "gone" as const;
      if (isUsable(latest)) return "fresh" as const;
      if ((latest.refreshLeaseUntil ?? 0) > Date.now()) return "busy" as const;
      tx.update(ref, { refreshLeaseUntil: Date.now() + LEASE_MS });
      return { refreshToken: latest.refreshToken };
    });

    if (lease === "gone") continue;
    if (lease === "fresh") continue;
    if (lease === "busy") {
      await sleep(REFRESH_WAIT_BASE_MS + attempt * REFRESH_WAIT_STEP_MS);
      continue;
    }

    try {
      const refreshed = await tokenRequest({ grant_type: "refresh_token", refresh_token: lease.refreshToken });
      await ref.update({
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        expiresAt: Date.now() + refreshed.expires_in * 1000,
        refreshLeaseUntil: 0,
      });
      return { token: refreshed.access_token, locationId: current.locationId };
    } catch (err) {
      if (err instanceof HttpError && err.code === "HL_RECONNECT") {
        await markDisconnected(uid, "expired");
      } else {
        await ref.update({ refreshLeaseUntil: 0 }).catch(() => undefined);
      }
      throw err;
    }
  }
  throw new HttpError(503, "HL_UNAVAILABLE", "Could not refresh the HighLevel connection. Try again.", true);
}
