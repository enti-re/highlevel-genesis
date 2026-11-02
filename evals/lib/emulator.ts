
const PROJECT = 'demo-genesis'
export const API = `http://127.0.0.1:5001/${PROJECT}/us-central1/api`
export const AUTH = 'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1'
export const FS = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`

export async function json(res: Response) {
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

export async function newUser() {
  const email = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@eval.local`
  const d = await json(await fetch(`${AUTH}/accounts:signUp?key=demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: `pw-${Math.random().toString(36).slice(2)}`, returnSecureToken: true }),
  }))
  const token: string = d.idToken
  const session = await fetch(`${API}/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
  const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0]
  await json(await fetch(`${API}/hl/authorize-url`, { headers: { Authorization: `Bearer ${token}` } })) // mock HL connect
  return { token, uid: d.localId as string, cookie }
}

export async function newProject(token: string, uid: string, name: string) {
  const now = new Date().toISOString()
  const d = await json(await fetch(`${FS}/projects`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: {
      ownerId: { stringValue: uid }, name: { stringValue: name }, description: { stringValue: '' },
      locationId: { nullValue: null }, deleted: { booleanValue: false }, activeGeneration: { nullValue: null },
      createdAt: { timestampValue: now }, updatedAt: { timestampValue: now },
    } }),
  }))
  return (d.name as string).split('/').pop()!
}

/** Runs one prompt through /generate and returns the terminal SSE event. */
export async function generate(token: string, projectId: string, prompt: string) {
  const res = await fetch(`${API}/generate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, prompt }),
  })
  if (!res.ok) return { generationId: null, end: { event: 'error', data: await res.json().catch(() => ({})) } }
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let generationId: string | null = null
  let end: { event: string; data: any } | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const event = raw.match(/^event: (.*)$/m)?.[1]
      const data = raw.match(/^data: (.*)$/m)?.[1]
      if (!event || !data) continue
      const parsed = JSON.parse(data)
      if (event === 'start') generationId = parsed.generationId
      if (event === 'done' || event === 'error') end = { event, data: parsed }
    }
  }
  return { generationId, end: end ?? { event: 'error', data: { code: 'STREAM_INTERRUPTED' } } }
}

/** Emulator admin read (bypasses rules). */
export const adminGet = async (path: string) => json(await fetch(`${FS}/${path}`, { headers: { Authorization: 'Bearer owner' } }))

export async function loadFiles(projectId: string) {
  const d = await adminGet(`projects/${projectId}/files?pageSize=100`)
  return new Map<string, string>((d.documents ?? []).map((doc: any) => [doc.fields.path.stringValue, doc.fields.content.stringValue]))
}

export const num = (v: any) => (v ? Number(v.integerValue ?? v.doubleValue ?? 0) : 0)

export async function loadGeneration(projectId: string, generationId: string) {
  const f = (await adminGet(`projects/${projectId}/generations/${generationId}`)).fields ?? {}
  const usage = f.usage?.mapValue?.fields ?? {}
  const metrics = f.metrics?.mapValue?.fields ?? {}
  const edits = metrics.edits?.mapValue?.fields ?? {}
  return {
    model: f.model?.stringValue ?? null,
    promptVersion: f.promptVersion?.stringValue ?? null,
    usage: {
      input: num(usage.inputTokens), output: num(usage.outputTokens),
      cacheRead: num(usage.cacheReadTokens), cacheWrite: num(usage.cacheCreationTokens),
    },
    ttftMs: num(metrics.ttftMs), durationMs: num(metrics.durationMs),
    edits: { applied: num(edits.applied), failed: num(edits.failed), repaired: num(edits.repaired) },
    confidence: f.confidence?.mapValue?.fields?.score ? num(f.confidence.mapValue.fields.score) : null,
  }
}

