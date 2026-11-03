import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { logger } from "firebase-functions";
import { APP_URL, isMockHl } from "../config";
import { requireSession, requireUser } from "../lib/auth";
import { HttpError } from "../lib/errors";
import { enforceRateLimit } from "../lib/rateLimit";
import { db } from "../lib/store";
import { callHl, fetchLocationName } from "../hl/client";
import { MOCK_LOCATION_ID } from "../hl/mock";
import { buildAuthorizeUrl, exchangeCode, markDisconnected, saveConnection } from "../hl/tokens";

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 24;
const STATE_FORMAT = new RegExp(`^[a-f0-9]{${STATE_BYTES * 2}}$`);
const HL_CALLS_PER_MINUTE = 120;
const MOCK_TOKEN_TTL_S = 24 * 60 * 60;

/** GET /hl/authorize-url -> { url }  (state binds the callback to this user; CSRF protection) */
export async function authorizeUrlHandler(req: Request, res: Response) {
  const user = await requireUser(req, { checkRevoked: true });
  if (isMockHl()) {
    await saveConnection(
      user.uid,
      { access_token: "mock", refresh_token: "mock", expires_in: MOCK_TOKEN_TTL_S, locationId: MOCK_LOCATION_ID },
      "Demo Clinic (mock)",
    );
    res.json({ url: `${APP_URL.value()}/dashboard?hl=connected` });
    return;
  }
  const state = randomBytes(STATE_BYTES).toString("hex");
  await db().collection("oauthStates").doc(state).set({ uid: user.uid, createdAt: Date.now() });
  res.json({ url: buildAuthorizeUrl(state) });
}

/**
 * GET /oauth/callback?code&state - HighLevel redirects the browser here after install.
 *
 * This does NOT finish the connection. If it did, anyone could start an install
 * under their own account and send the link to a HighLevel admin: the admin's
 * location would be saved under the attacker's uid. Instead we hand code+state
 * to the Genesis tab (in the URL fragment, which never reaches servers or
 * Referer headers), and that tab finishes with its own ID token, so the state
 * must belong to whoever is signed in to this browser.
 */
export async function oauthCallbackHandler(req: Request, res: Response) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const dashboard = `${APP_URL.value()}/dashboard`;
  if (!code) return res.redirect(302, `${dashboard}?${new URLSearchParams({ hl: "error", reason: "missing_code" })}`);
  // HighLevel's install link may not echo `state` back. Without it we can't tie the
  // callback to a user, so we refuse rather than guess.
  if (!state) return res.redirect(302, `${dashboard}?${new URLSearchParams({ hl: "error", reason: "missing_state" })}`);
  return res.redirect(302, `${dashboard}#${new URLSearchParams({ hl_code: code, hl_state: state })}`);
}

/** POST /hl/complete { code, state } - finishes the OAuth install for the signed-in user. */
export async function completeOauthHandler(req: Request, res: Response) {
  const user = await requireUser(req, { checkRevoked: true });
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const state = typeof req.body?.state === "string" ? req.body.state : "";
  if (!code || !STATE_FORMAT.test(state)) throw new HttpError(400, "BAD_REQUEST", "Invalid connection request.");

  // Single use: read and delete in one transaction so a state can't be redeemed twice.
  const stateRef = db().collection("oauthStates").doc(state);
  const stored = await db().runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    if (snap.exists) tx.delete(stateRef);
    return snap.exists ? { uid: snap.get("uid") as string, createdAt: Number(snap.get("createdAt")) } : null;
  });
  if (!stored || Date.now() - stored.createdAt > STATE_TTL_MS) {
    throw new HttpError(400, "EXPIRED_STATE", "The connection request expired. Please try again.");
  }
  if (stored.uid !== user.uid) {
    logger.warn("oauth_state_mismatch", { uid: user.uid });
    throw new HttpError(
      403,
      "OAUTH_STATE_MISMATCH",
      "This connect link was started from a different Genesis account. Use the Connect button in your own dashboard.",
    );
  }

  const tokens = await exchangeCode(code);
  const locationName = tokens.locationId ? await fetchLocationName(tokens.access_token, tokens.locationId) : null;
  await saveConnection(user.uid, tokens, locationName);
  res.json({ ok: true });
}

/** POST /hl/disconnect */
export async function disconnectHandler(req: Request, res: Response) {
  const user = await requireUser(req, { checkRevoked: true });
  await markDisconnected(user.uid, "disconnected");
  res.json({ ok: true });
}

/**
 * POST /hl/call { op, params } - the only path from generated apps to HighLevel data.
 * Authenticated by the httpOnly session cookie, not the ID token (see lib/auth.ts).
 */
export async function callHandler(req: Request, res: Response) {
  const user = await requireSession(req);
  const op = String(req.body?.op ?? "");
  const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : {};
  await enforceRateLimit(user.uid, "hl", HL_CALLS_PER_MINUTE, 60 * 1000);
  const data = await callHl(user.uid, op, params);
  res.json({ data });
}
