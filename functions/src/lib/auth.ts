import type { Request, Response } from "express";
import { getAuth } from "firebase-admin/auth";
import { APP_URL } from "../config";
import { HttpError } from "./errors";

export interface AuthedUser {
  uid: string;
  email?: string;
}

/** `checkRevoked` costs one Auth lookup but cuts off a revoked user now instead of at token expiry. */
export async function requireUser(req: Request, opts: { checkRevoked?: boolean } = {}): Promise<AuthedUser> {
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in again.");
  try {
    const decoded = await getAuth().verifyIdToken(header.slice("Bearer ".length), opts.checkRevoked ?? false);
    return { uid: decoded.uid, email: decoded.email };
  } catch {
    throw new HttpError(401, "UNAUTHENTICATED", "Your session expired. Please sign in again.");
  }
}

/*
 * CRM access accepts only this httpOnly cookie, so a stolen ID token (it lives in
 * browser storage for Firestore listeners) can't reach the CRM. `__session` is the
 * only cookie Firebase Hosting forwards to functions.
 */
export const SESSION_COOKIE = "__session";
const SESSION_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;
/** A session can only be minted right after a real sign-in, not from an old (possibly stolen) ID token. */
const RECENT_SIGN_IN_S = 5 * 60;

function allowedOrigins(): string[] {
  const app = APP_URL.value();
  return [app, app.replace(".web.app", ".firebaseapp.com")];
}

/** Cookies are sent automatically, so cookie-authenticated routes must reject cross-site callers (CSRF). */
function assertSameSite(req: Request) {
  const origin = req.headers.origin;
  if (!origin) return; // same-origin GETs and non-browser clients omit it; SameSite=Strict covers browsers
  if (allowedOrigins().includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) return;
  throw new HttpError(403, "FORBIDDEN", "Cross-site request blocked.");
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** POST /session (Bearer ID token) -> sets the httpOnly CRM session cookie. */
export async function createSessionHandler(req: Request, res: Response) {
  assertSameSite(req);
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in again.");
  const idToken = header.slice("Bearer ".length);
  const decoded = await getAuth().verifyIdToken(idToken, true).catch(() => {
    throw new HttpError(401, "UNAUTHENTICATED", "Your session expired. Please sign in again.");
  });
  if (Date.now() / 1000 - decoded.auth_time > RECENT_SIGN_IN_S) {
    throw new HttpError(401, "RECENT_SIGN_IN_REQUIRED", "Please sign in again to continue.");
  }
  const cookie = await getAuth().createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });
  res.cookie(SESSION_COOKIE, cookie, {
    maxAge: SESSION_MAX_AGE_MS,
    httpOnly: true, // invisible to JavaScript, so XSS can't exfiltrate it
    secure: true, // browsers treat http://localhost as secure, so this works in dev too
    sameSite: "strict",
    path: "/",
  });
  res.json({ ok: true });
}

export async function deleteSessionHandler(req: Request, res: Response) {
  assertSameSite(req);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
  res.json({ ok: true });
}

/** Authenticates a CRM route from the session cookie, with revocation checked on every call. */
export async function requireSession(req: Request): Promise<AuthedUser> {
  assertSameSite(req);
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) throw new HttpError(401, "SESSION_REQUIRED", "Your session expired. Please sign in again.");
  try {
    const decoded = await getAuth().verifySessionCookie(cookie, true);
    return { uid: decoded.uid, email: decoded.email };
  } catch {
    throw new HttpError(401, "SESSION_REQUIRED", "Your session expired. Please sign in again.");
  }
}
