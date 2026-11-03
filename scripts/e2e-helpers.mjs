// Helpers for scripts/e2e-emulator.mjs: emulator endpoints, auth, Firestore REST, SSE reader.

export const PROJECT = 'demo-genesis'
export const API = `http://127.0.0.1:5001/${PROJECT}/us-central1/api`
export const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
export const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`

let failures = 0
export const failureCount = () => failures
export const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

export async function signUp(email) {
  const res = await fetch(`${AUTH}/accounts:signUp?key=demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', returnSecureToken: true }),
  })
  const account = await res.json()
  return { token: account.idToken, uid: account.localId }
}

export const api = (token, path, body, method = body ? 'POST' : 'GET') =>
  fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })

// CRM calls are authenticated by the httpOnly session cookie on the same-origin /api path, not the ID token.
export const hlCall = (cookie, body, headers = {}) =>
  fetch(`${API}/api/hl/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: JSON.stringify(body),
  })

export const fsGet = (token, path) => fetch(`${FS}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
export const fsCreate = (token, collection, fields) =>
  fetch(`${FS}/${collection}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
export const fsPatch = (token, path, fields, mask) =>
  fetch(`${FS}/${path}?${mask.map((field) => `updateMask.fieldPaths=${field}`).join('&')}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
export const fsList = async (token, path) => (await (await fsGet(token, path)).json()).documents ?? []

export async function generate(token, projectId, prompt, { onEvent, abortAfterEvents } = {}) {
  const res = await api(token, '/generate', { projectId, prompt })
  if (!res.ok) return { status: res.status, body: await res.json(), events: [] }
  const events = []
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const ev = raw.match(/^event: (.*)$/m)?.[1]
      const data = raw.match(/^data: (.*)$/m)?.[1]
      if (!ev) continue
      const sseEvent = { event: ev, data: JSON.parse(data) }
      events.push(sseEvent)
      await onEvent?.(sseEvent, events)
      if (abortAfterEvents && events.length >= abortAfterEvents) {
        await reader.cancel()
        return { status: 200, events, aborted: true }
      }
    }
  }
  return { status: 200, events }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
