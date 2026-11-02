import { signOut } from 'firebase/auth'
import { API_BASE_URL, auth } from './firebase'

/** Same-origin path (Hosting rewrite / Vite proxy) for cookie-authenticated routes. */
const SAME_ORIGIN_API = '/api'

export class ApiError extends Error {
  status: number
  code: string
  retryable: boolean
  constructor(status: number, code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export async function authHeader(): Promise<string> {
  const user = auth.currentUser
  if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.')
  try {
    return `Bearer ${await user.getIdToken()}`
  } catch {
    // Refresh token revoked or account deleted: sign out instead of showing a misleading network error.
    await endSession()
    throw new ApiError(401, 'UNAUTHENTICATED', 'Your session expired. Please sign in again.')
  }
}

/** Call right after sign-in: the server only mints the CRM cookie for a sign-in under 5 minutes old. */
export async function startSession(): Promise<void> {
  const res = await fetch(`${SAME_ORIGIN_API}/session`, { method: 'POST', headers: { Authorization: await authHeader() } })
  if (!res.ok) throw await toApiError(res)
}

/** Clears the CRM cookie and the Firebase session. App.vue redirects to /login. */
export async function endSession(): Promise<void> {
  await fetch(`${SAME_ORIGIN_API}/session/logout`, { method: 'POST' }).catch(() => undefined)
  await signOut(auth).catch(() => undefined)
}

export async function toApiError(res: Response): Promise<ApiError> {
  const data = await res.json().catch(() => null)
  return new ApiError(
    res.status,
    data?.error?.code ?? `HTTP_${res.status}`,
    data?.error?.message ?? `Request failed (${res.status})`,
    data?.error?.retryable ?? res.status >= 500,
  )
}

/** `session: true` authenticates with the httpOnly cookie instead of the ID token (CRM calls). */
export async function apiFetch<T>(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; session?: boolean } = {},
  signal?: AbortSignal,
): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${init.session ? SAME_ORIGIN_API : API_BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.session ? {} : { Authorization: await authHeader() }),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'same-origin',
      signal,
    })
  } catch (err) {
    if (err instanceof ApiError || (err as Error).name === 'AbortError') throw err
    throw new ApiError(0, 'NETWORK', 'Network error: check your connection and try again.', true)
  }
  if (!res.ok) {
    const error = await toApiError(res)
    // Cookie missing/expired/revoked: sign out fully so the user signs in again and gets a new one.
    if (error.code === 'SESSION_REQUIRED') await endSession()
    throw error
  }
  return (await res.json()) as T
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong.'
}
