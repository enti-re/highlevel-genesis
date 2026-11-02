// End-to-end checks against the emulators in mock mode (MOCK_LLM=true, MOCK_HL=true).
// Run: node scripts/e2e-emulator.mjs
import { PROJECT, API, AUTH, FS, failureCount, check, signUp, api, hlCall, fsGet, fsCreate, fsPatch, fsList, generate, sleep } from './e2e-helpers.mjs'

const a = await signUp(`a${Date.now()}@test.dev`)
const b = await signUp(`b${Date.now()}@test.dev`)
check('sign up two users', !!a.token && !!b.token)

check('health', (await (await fetch(`${API}/health`)).json()).ok === true)
// The functions emulator cold-starts a separate worker per concurrent request; warm a few up
// so the concurrency checks below measure our lock, not emulator start-up time.
await Promise.all(Array.from({ length: 4 }, () => fetch(`${API}/health`)))
check('API rejects missing token', (await fetch(`${API}/hl/authorize-url`)).status === 401)

// Rules: create project as A
const created = await fsCreate(a.token, 'projects', {
  ownerId: { stringValue: a.uid }, name: { stringValue: 'E2E' }, description: { stringValue: '' },
  locationId: { nullValue: null }, deleted: { booleanValue: false }, activeGeneration: { nullValue: null },
  createdAt: { timestampValue: new Date().toISOString() }, updatedAt: { timestampValue: new Date().toISOString() },
})
const projectDoc = await created.json()
const projectId = projectDoc.name?.split('/').pop()
check('rules: owner can create project', created.ok, created.ok ? '' : JSON.stringify(projectDoc))
const spoof = await fsCreate(b.token, 'projects', {
  ownerId: { stringValue: a.uid }, name: { stringValue: 'spoof' }, deleted: { booleanValue: false }, activeGeneration: { nullValue: null },
})
check('rules: cannot create project for another user', spoof.status === 403)
check('rules: other user cannot read project', (await fsGet(b.token, `projects/${projectId}`)).status === 403)
check(
  'rules: client cannot set activeGeneration',
  (await fsPatch(a.token, `projects/${projectId}`, { activeGeneration: { mapValue: { fields: { id: { stringValue: 'x' } } } } }, ['activeGeneration'])).status === 403,
)

// CRM session cookie (lib/auth.ts)
const sessionRes = await api(a.token, '/api/session', {})
const setCookie = sessionRes.headers.get('set-cookie') ?? ''
check('session: created from a fresh sign-in', sessionRes.ok, String(sessionRes.status))
check('session: cookie is httpOnly + Secure + SameSite=Strict', /^__session=/.test(setCookie) && /HttpOnly/i.test(setCookie) && /Secure/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie.slice(0, 80))
const cookie = setCookie.split(';')[0]
const viaIdToken = await api(a.token, '/api/hl/call', { op: 'contacts.list' })
check('session: /hl/call rejects an ID token without the cookie (401 SESSION_REQUIRED)', viaIdToken.status === 401 && (await viaIdToken.json()).error?.code === 'SESSION_REQUIRED')
check('session: forged cookie rejected', (await hlCall('__session=forged', { op: 'contacts.list' })).status === 401)
check('session: cross-site Origin rejected (CSRF)', (await hlCall(cookie, { op: 'contacts.list' }, { Origin: 'https://evil.example' })).status === 403)

// HighLevel (mock) connect + proxy
check('HL call before connecting -> HL_NOT_CONNECTED or mock ok', [200, 409].includes((await hlCall(cookie, { op: 'contacts.list' })).status))
const authz = await (await api(a.token, '/hl/authorize-url')).json()
check('mock OAuth connect returns redirect', authz.url?.includes('hl=connected'))
const user = await (await fsGet(a.token, `users/${a.uid}`)).json()
check('users/{uid}.hl.status = connected', user.fields?.hl?.mapValue?.fields?.status?.stringValue === 'connected')
check('rules: other user cannot read my users doc', (await fsGet(b.token, `users/${a.uid}`)).status === 403)

// OAuth install is finished by the signed-in tab, so a link started by one account can't connect another's CRM.
const cb = await fetch(`${API}/oauth/callback?code=c0de&state=${'ab'.repeat(24)}`, { redirect: 'manual' })
check('oauth: callback hands code+state to the app in the fragment (no server-side connect)', cb.status === 302 && /\/dashboard#hl_code=c0de&hl_state=/.test(cb.headers.get('location') ?? ''), cb.headers.get('location') ?? '')
const stateA = [...crypto.getRandomValues(new Uint8Array(24))].map((x) => x.toString(16).padStart(2, '0')).join('')
await fetch(`${FS}/oauthStates?documentId=${stateA}`, {
  method: 'POST',
  headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, // emulator admin: bypasses rules
  body: JSON.stringify({ fields: { uid: { stringValue: a.uid }, createdAt: { integerValue: String(Date.now()) } } }),
})
const stolen = await api(b.token, '/hl/complete', { code: 'c0de', state: stateA })
const stolenBody = await stolen.json()
check('oauth: state started by user A cannot be completed by user B (403)', stolen.status === 403 && stolenBody.error?.code === 'OAUTH_STATE_MISMATCH', `${stolen.status} ${stolenBody.error?.code}`)
const reused = await api(a.token, '/hl/complete', { code: 'c0de', state: stateA })
check('oauth: state is single use', reused.status === 400 && (await reused.json()).error?.code === 'EXPIRED_STATE')
const contacts = await (await hlCall(cookie, { op: 'contacts.list', params: { query: 'diya' } })).json()
check('HL proxy contacts.list normalized', contacts.data?.contacts?.[0]?.name === 'Diya Patel', JSON.stringify(contacts).slice(0, 120))
const events = await (await hlCall(cookie, { op: 'calendars.events', params: {} })).json()
check('HL proxy calendars.events fans out without calendarId', events.data?.events?.length === 3)
const bad = await hlCall(cookie, { op: 'contacts.get', params: { contactId: '../x' } })
check('HL proxy rejects path injection', bad.status === 400)
check('HL proxy rejects unknown op', (await hlCall(cookie, { op: 'users.delete' })).status === 400)

// Generation: happy path
const g1 = await generate(a.token, projectId, 'Build a contact dashboard with search and upcoming appointments')
const kinds = g1.events.map((e) => e.event)
check('SSE: start first, done last', kinds[0] === 'start' && kinds.at(-1) === 'done', kinds.slice(-3).join(','))
check('SSE: file boundaries + tokens', kinds.includes('file_start') && kinds.includes('token') && kinds.includes('file_end'))
const done = g1.events.at(-1).data
check('generation complete with 3 files', done.status === 'complete' && done.files.length === 3, JSON.stringify(done))
const files = await fsList(a.token, `projects/${projectId}/files`)
check('files saved to Firestore', files.length === 3)
const streamedApp = g1.events.filter((e) => e.event === 'token' && e.data.path === 'app.js').map((e) => e.data.delta).join('')
const savedApp = files.find((f) => f.fields.path.stringValue === 'app.js')?.fields.content.stringValue
check('streamed tokens == saved file', streamedApp.trimEnd() === savedApp)
let snaps = await fsList(a.token, `projects/${projectId}/snapshots`)
check('snapshot created', snaps.length === 1)
check('rules: client cannot write snapshots', (await fsCreate(a.token, `projects/${projectId}/snapshots`, { label: { stringValue: 'x' } })).status === 403)
const proj = await (await fsGet(a.token, `projects/${projectId}`)).json()
check('lock released', proj.fields.activeGeneration?.nullValue === null)

// Search/replace edit: only the changed lines are sent, the saved file is patched
const ge = await generate(a.token, projectId, 'rename the contacts heading')
const geDone = ge.events.at(-1).data
check('edit: SSE edit_start/edit_end, no file tokens', ge.events.some((e) => e.event === 'edit_end') && !ge.events.some((e) => e.event === 'token'))
check('edit: complete, app.js changed', geDone.status === 'complete' && geDone.files.join() === 'app.js', JSON.stringify(geDone))
const editedApp = (await fsList(a.token, `projects/${projectId}/files`)).find((f) => f.fields.path.stringValue === 'app.js').fields.content.stringValue
check('edit: patched in place, rest of file intact', editedApp === savedApp.replace('font-semibold">Contacts<', 'font-semibold">People<'))
const gm = await generate(a.token, projectId, 'mismatch edit please')
const gmDone = gm.events.at(-1).data
const repairedApp = (await fsList(a.token, `projects/${projectId}/files`)).find((f) => f.fields.path.stringValue === 'app.js').fields.content.stringValue
check('edit: non-matching search -> one full-file repair call, saved', gmDone.status === 'complete' && repairedApp === savedApp && gm.events.some((e) => e.event === 'warning'), JSON.stringify(gmDone).slice(0, 160))
// Unrepairable edit (B's empty project, so A's rate-limit budget is untouched)
const bProject = await (await fsCreate(b.token, 'projects', {
  ownerId: { stringValue: b.uid }, name: { stringValue: 'B' }, description: { stringValue: '' },
  locationId: { nullValue: null }, deleted: { booleanValue: false }, activeGeneration: { nullValue: null },
  createdAt: { timestampValue: new Date().toISOString() }, updatedAt: { timestampValue: new Date().toISOString() },
})).json()
const gb = await generate(b.token, bProject.name.split('/').pop(), 'mismatch norepair')
const gbEnd = gb.events.at(-1)
check('edit: unrepairable -> retryable EDIT_FAILED, nothing saved', gbEnd.event === 'error' && gbEnd.data.code === 'EDIT_FAILED' && gbEnd.data.retryable === true && !gbEnd.data.savedFiles.length, JSON.stringify(gbEnd.data).slice(0, 160))

// Manual edit via rules
const appDocName = files.find((f) => f.fields.path.stringValue === 'app.js').name.split('/documents/')[1]
const edit = await fsPatch(a.token, appDocName, { content: { stringValue: savedApp + '\n// edited' }, updatedBy: { stringValue: 'user' } }, ['content', 'updatedBy'])
check('rules: owner can save manual edit', edit.ok)
check(
  'rules: manual edit cannot rename path',
  (await fsPatch(a.token, appDocName, { path: { stringValue: 'evil.js' }, updatedBy: { stringValue: 'user' } }, ['path', 'updatedBy'])).status === 403,
)

// Partial failure: stream drops mid-file
const g2 = await generate(a.token, projectId, 'please fail halfway')
const err = g2.events.at(-1)
check('dropped stream -> error event', err.event === 'error', JSON.stringify(err.data).slice(0, 150))
check('dropped stream keeps finished files (partial)', err.data.status === 'partial' && err.data.savedFiles.includes('index.html'))
snaps = await fsList(a.token, `projects/${projectId}/snapshots`)
check('partial snapshot recorded', snaps.some((s) => s.fields.status.stringValue === 'partial'))
check('manual edit captured as its own snapshot before AI overwrite', snaps.some((s) => s.fields.label.stringValue === 'Manual edits'))

// Lock: concurrent generate -> 409
let conflict = null
const g3 = await generate(a.token, projectId, 'another app', {
  onEvent: async (e) => {
    if (e.event === 'start' && !conflict) conflict = await api(a.token, '/generate', { projectId, prompt: 'second' })
  },
})
check('concurrent generation rejected with 409', conflict?.status === 409, `g3=${g3.status} ${JSON.stringify(g3.body ?? '')} conflict=${conflict?.status}`)

// Lock blocks manual edits during generation
let editDuring = null
await generate(a.token, projectId, 'third', {
  onEvent: async (e) => {
    if (e.event === 'start' && !editDuring) {
      editDuring = await fsPatch(a.token, appDocName, { content: { stringValue: 'x' }, updatedBy: { stringValue: 'user' } }, ['content', 'updatedBy'])
    }
  },
})
check('rules: manual edit blocked mid-generation', editDuring?.status === 403)

// Cancel mid-stream
let cancelled = false
const g4 = await generate(a.token, projectId, 'cancel me', {
  onEvent: async (e) => {
    if (e.event === 'token' && !cancelled) {
      cancelled = true
      const genId = g4Start
      await api(a.token, '/generate/cancel', { projectId, generationId: genId })
    }
    if (e.event === 'start') g4Start = e.data.generationId
  },
})
var g4Start
check('cancel -> CANCELLED error event', g4.events.at(-1).event === 'error' && g4.events.at(-1).data.code === 'CANCELLED', JSON.stringify(g4.events.at(-1).data).slice(0, 120))

// Client disconnects mid-stream -> server still saves
const before = (await fsList(a.token, `projects/${projectId}/snapshots`)).length
await generate(a.token, projectId, 'disconnect test', { abortAfterEvents: 5 })
let after = before
for (let i = 0; i < 40 && after === before; i++) {
  await sleep(250)
  after = (await fsList(a.token, `projects/${projectId}/snapshots`)).length
}
check('client disconnect: server still saves snapshot', after === before + 1)

// Restore the first snapshot
snaps = await fsList(a.token, `projects/${projectId}/snapshots`)
const oldest = snaps.sort((x, y) => x.fields.createdAt.timestampValue.localeCompare(y.fields.createdAt.timestampValue))[0]
const oldestId = oldest.name.split('/').pop()
const restore = await api(a.token, `/projects/${projectId}/snapshots/${oldestId}/restore`, {})
check('restore ok', restore.ok, restore.ok ? '' : await restore.text())
const restoredApp = (await fsList(a.token, `projects/${projectId}/files`)).find((f) => f.fields.path.stringValue === 'app.js').fields.content.stringValue
check('restore reverted file content', restoredApp === savedApp)
check('restore created a new snapshot', (await fsList(a.token, `projects/${projectId}/snapshots`)).length === snaps.length + 1)
check('other user cannot restore', (await api(b.token, `/projects/${projectId}/snapshots/${oldestId}/restore`, {})).status === 404)

// Soft delete
check('rules: owner can soft-delete', (await fsPatch(a.token, `projects/${projectId}`, { deleted: { booleanValue: true } }, ['deleted'])).ok)
check('rules: hard delete denied', (await fetch(`${FS}/projects/${projectId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${a.token}` } })).status === 403)
check('deleted project cannot generate', (await api(a.token, '/generate', { projectId, prompt: 'x' })).status === 404)

console.log(failureCount() ? `\n${failureCount()} check(s) FAILED` : '\nAll checks passed')
process.exit(failureCount() ? 1 : 0)
