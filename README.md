# Genesis: AI-powered HighLevel app builder

Describe an app in chat. Genesis streams the code into an editor in real time and runs it in a live preview that reads **real HighLevel data** (contacts, conversations, calendars) through a secure proxy. Every generation is versioned and restorable.

**Stack:** Vue 3 + TypeScript + shadcn-vue · Firebase Auth, Firestore, Cloud Functions (2nd gen), Hosting · Claude (`@anthropic-ai/sdk`, streaming)

| | |
|---|---|
| Live app | `[https://YOUR_PROJECT_ID.web.app](https://genesis-app-builder.web.app/dashboard)` |
| Functions base URL | `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/api` |
| Loom walkthrough | *(link added after recording)* |

---

## How it works

> Full system design: **[docs/DESIGN.md](docs/DESIGN.md)**. Its first section, *At a glance*, is a one-minute summary (diagram, five key decisions, evidence); §16 lists known limitations.

```
 Browser (Vue 3 + shadcn-vue)
 ┌──────────────┬───────────────────────┬────────────────────────────┐
 │ Chat         │ Monaco editor + tree  │ Preview iframe (own page,  │
 │              │ (streams live tokens) │ sandbox: allow-scripts)    │
 └──────┬───────┴──────────▲────────────┴──────────┬─────────────────┘
        │ POST /generate   │ SSE events            │ window.hl.contacts.list()
        │                  │                       │   └─ postMessage to parent
        ▼                  │                       ▼
 ┌─────────────────────────┴──────┐     ┌──────────────────────────────────┐
 │ /generate (Cloud Function)     │     │ parent page → POST /hl/call      │
 │ 1 lock project (transaction)   │     │ (httpOnly session cookie)        │
 │ 2 bounded context              │     │ /hl/call: whitelisted op →       │
 │ 3 stream Claude                │     │ validate params → inject         │
 │ 4 parse <file> tags live → SSE │     │ locationId → refresh token       │
 │ 5 validate file ops            │     │ (leased) → HighLevel API →       │
 │ 6 ONE batch: files + snapshot  │     │ normalize response               │
 │   + messages + unlock          │     └──────────────────────────────────┘
 └────────────────────────────────┘
 Firestore: users · projects/{id}/{files,snapshots,messages,generations}
            hlConnections (tokens, server-only) · oauthStates · rateLimits
```

**Generation flow.** The model writes `<file path="…">…</file>` blocks (plus optional `<delete path="…"/>`). An incremental parser (`functions/src/generation/parser.ts`) handles tags split across arbitrary token boundaries and turns them into SSE events. For changes to existing files it writes `<edit path="…">` search/replace blocks instead of the whole file (`edits.ts`); an edit that doesn't match triggers one follow-up call for the full file, and edits are all-or-nothing per file. When the stream ends, the proposed files are validated (path, type and size checks) and committed **atomically** together with a snapshot.

**Preview flow.** The preview is an iframe of `/preview.html` sandboxed **without** `allow-same-origin`; the parent posts it the built app, which it writes into itself (its own CSP: no network access). Local `<script src>`/`<link>` tags are inlined, and a tiny runtime defines `window.hl`. Each `hl.*` call is a `postMessage` to the parent. The parent makes the authenticated call to `/api/hl/call` (httpOnly session cookie), which runs one of 11 whitelisted operations and returns a normalized shape. **No token ever reaches generated code.**

### SSE event protocol (`POST /generate`)

| Event | Payload | Meaning |
|---|---|---|
| `start` | `{ generationId }` | Lock acquired, generation running |
| `text` | `{ delta }` | Assistant chat text (outside file tags) |
| `file_start` | `{ path }` | A file begins |
| `token` | `{ path, delta }` | File content as it streams |
| `file_end` | `{ path }` | File closed (complete) |
| `edit_start` | `{ path }` | Model is patching a file with search/replace blocks (no tokens streamed) |
| `edit_end` | `{ path }` | Edit block closed; applied atomically per file after the stream |
| `file_delete` | `{ path }` | Model asked to delete a file |
| `warning` | `{ message }` | Non-fatal issue (e.g. length limit hit) |
| `reset` | `{}` | Server-side model fallback re-ran the request: discard partial output |
| `done` | `{ status, snapshotId, files, deleted, warnings }` | Saved |
| `error` | `{ code, message, retryable, status, savedFiles }` | Failed or cancelled; completed files were still saved |

Comment heartbeats (`: ping`) every 10 s keep proxies from closing the stream while the model is thinking.

### Error handling

| Failure | What the user sees | What happens to the data |
|---|---|---|
| Stream drops mid-generation (LLM side) | "Lost connection to the AI… finished files were kept" | Completed files saved, snapshot marked **partial** |
| Malformed output (bad path, unclosed tag, empty file) | Per-file warning | That file is skipped and the rest are kept. 0 files → no snapshot |
| Browser disconnects | "Connection lost, server still finishing" | Server **keeps going and saves**. UI recovers from Firestore when the lock clears |
| Cancel | "Generation cancelled" | Abort via a Firestore flag. Completed files kept |
| LLM 429 / 5xx | "AI busy, retry" + Retry button | SDK retries only **before** the first token (no duplicated output) |
| Double submit / second tab | 409 `GENERATION_IN_PROGRESS` | Transactional per-project lock (auto-expires after 10 min) |
| HighLevel token expired | Nothing | Refreshed under a Firestore **lease**: HL refresh tokens rotate, so concurrent refreshes would log the user out |
| HighLevel refresh revoked | "Reconnect HighLevel" | Connection marked `expired` |
| HighLevel 401 mid-call | Nothing | Force one refresh, retry once |
| HighLevel 403 / 429 / 5xx / timeout | Generated app's own error state | Typed `HLError` (`code`, `retryable`). The prompt *requires* loading/error/empty states |
| Manual edit during generation | Editor locked | Firestore rules reject file writes while the project is locked |
| Unsaved edits + new generation | Send blocked until save/discard | Saved hand edits are snapshotted as "Manual edits" before an AI overwrite |
| Runtime error in generated app | Banner with the error | Reported from the iframe via `postMessage` |
| OAuth CSRF / replay | Error toast | Single-use `state` doc bound to the user, 10-min TTL |

---

## HighLevel setup

1. Create a developer account at [developers.gohighlevel.com](https://developers.gohighlevel.com), then create a **Marketplace app** (distribution: *Sub-account*).
2. **Scopes:** `contacts.readonly contacts.write conversations.readonly conversations.write conversations/message.readonly conversations/message.write calendars.readonly calendars/events.readonly locations.readonly`
3. **Redirect URL:** `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/api/oauth/callback` (must equal `${API_BASE_URL}/oauth/callback` exactly).
4. Copy the **Client ID** into `functions/.env` and the **Client secret** into Secret Manager (see Deployment).
5. Create a **sandbox** sub-account from the developer dashboard and add a few contacts, a calendar with appointments, and a couple of conversations.
6. In the app: Dashboard → **Connect HighLevel** → choose the sandbox location.

## Local setup

Requirements: Node 22, Java 21+ (Firestore emulator), `firebase-tools`.

```bash
npm --prefix functions install && npm --prefix frontend install

# Emulator config (mock mode: canned LLM stream + fake HighLevel data, no keys needed)
cp .env.example functions/.env.local    # then set MOCK_LLM=true MOCK_HL=true,
                                        # API_BASE_URL=http://127.0.0.1:5001/demo-genesis/us-central1/api
printf 'ANTHROPIC_API_KEY=x\nHL_CLIENT_SECRET=x\nGEMINI_API_KEY=x\n' > functions/.secret.local
printf 'VITE_USE_EMULATORS=true\nVITE_FIREBASE_PROJECT_ID=demo-genesis\nVITE_API_BASE_URL=http://127.0.0.1:5001/demo-genesis/us-central1/api\n' > frontend/.env.development.local

npm --prefix functions run build
firebase emulators:start --project demo-genesis   # Auth, Firestore, Functions (+ UI on :4000)
npm --prefix frontend run dev                       # http://localhost:5173
```

To use the **real** Claude API and HighLevel locally, set `MOCK_LLM=false` / `MOCK_HL=false`, put real secrets in `functions/.secret.local`, and register `http://127.0.0.1:5001/demo-genesis/us-central1/api/oauth/callback` as an extra redirect URL in the HighLevel app.

**Tests**

```bash
npm --prefix functions test            # unit: parser, edits, repair/syntax, validation, LLM fallback + error mapping, HL ops + retry, confidence (106 tests)
npm --prefix functions run test:coverage   # same suite with line coverage (logic modules ~100%; routes/IO are covered by e2e)
npm --prefix frontend test             # unit: preview builder + starter kit, SSE parser (11 tests)
node scripts/e2e-emulator.mjs          # end-to-end against emulators (53 checks): rules, OAuth,
                                       # proxy, SSE, partial save, lock, cancel, disconnect, restore
frontend/node_modules/.bin/jiti evals/run.ts   # evals: real model, 15 cases, headless-Chrome render (evals/README.md)
npm run format:check --prefix functions && npm run format:check --prefix frontend   # Prettier
```

**CI** (`.github/workflows/ci.yml`) runs on every push: Prettier check, typecheck + build, both unit suites, then the e2e suite against the emulators in mock mode (no real keys in CI). Evals are not in CI because they spend model tokens; run them on prompt, spec, kit or model changes.

---

## Architecture decisions

1. **SSE over WebSockets.** The stream is one-way and Cloud Functions can't hold WebSockets. The client uses `fetch` + a stream reader rather than `EventSource`, because `EventSource` can't POST or send an `Authorization` header.
2. **Tagged output (`<file>`, `<edit>` search/replace, `<delete>`), not JSON or tool calls.** Tags stream naturally into the editor and parse incrementally; edits keep small changes small (output tokens are the main cost). A broken stream still yields every *completed* file, whereas half-streamed JSON is unusable and one bad escape invalidates everything.
3. **A postMessage bridge instead of tokens in the iframe.** The sandbox has no `allow-same-origin`, so generated code can't reach the user's session. The parent proxies calls with an httpOnly session cookie, and HighLevel tokens never leave the server.
4. **A whitelisted, normalized `hl` client instead of raw HighLevel docs in the prompt.** The model codes against 11 small, stable shapes (`spec.ts`). That bounds the context, stops it inventing endpoints, and absorbs API quirks server-side (e.g. nested `messages.messages`, events requiring a `calendarId` → fan out over calendars).
5. **The server is the source of truth, and each generation saves atomically.** Tokens are paid for, so a closed tab still produces a saved result; Firestore listeners, not the stream, drive saved state, which is what makes recovery work. Files, snapshot, messages, generation record and unlock commit in one batch, so a snapshot never disagrees with the files.
6. **Full-copy snapshots (not diffs).** Restore is a single write and easy to reason about. Project size is capped (450 KB) to stay under Firestore's 1 MiB document limit. Restoring creates a new snapshot, so restores are undoable.
7. **Leased token refresh.** HighLevel refresh tokens are single-use, so refresh runs under a short Firestore lease; concurrent requests wait and re-read instead of burning the token.
8. **An iframe preview (`/preview.html`) with a preloaded starter kit, not Sandpack/WebContainers.** It's instant with no bundler or special COOP/COEP headers. The trade-off is no npm imports, so every preview preloads a pinned kit: Vue 3, Tailwind v4 (browser build), shadcn theme tokens (same as Genesis), lucide icons via `<g-icon>`, and `genesis.useHl()` for loading/error/empty states. Apps match the builder's look, and outputs shrank by about 40–65% in testing (fewer tokens, fewer bugs). Duplicate Vue/Tailwind tags the model adds are stripped, because two Vue instances silently break reactivity.
9. **Browser security without a full BFF.** A strict CSP lets only our own bundle run on the Genesis page (Monaco is bundled, not loaded from a CDN) and only talk to our API and Firebase. CRM calls (`/hl/call`) accept only an httpOnly, SameSite=Strict session cookie, so a stolen ID token can't reach anyone's CRM. The preview page has its own CSP (`connect-src 'none'`, no remote images, no popups), which closes the easy ways for generated code to send CRM data out; self-navigation remains (DESIGN §9), and the kit's CDN scripts are SRI-pinned. A full BFF would also take the ID token out of JavaScript, but would break the live Firestore listeners the UI is built on; it's the production target (DESIGN §9).
10. **Cost, reliability and quality controls.** Claude primary with a Gemini fallback when Claude is unavailable before the first token; prompt caching, rate limits (10 generations / 10 min, 120 HighLevel calls / min), bounded repair calls, a per-generation confidence score, and an eval suite that renders generated apps in headless Chrome (`evals/`).

## What I would improve

1. **Resumable streams.** Persist SSE events so a reconnecting tab replays tokens live instead of waiting for the final save.
2. **Automatic self-repair and model routing.** "Fix with AI" sends a preview error back today; next, render headless before saving and loop at most twice, and route small edits to a cheaper model. The eval suite (`evals/`) measures both.
3. **Encrypt HighLevel tokens at rest** with Cloud KMS (today: server-only Firestore collection, denied to clients by rules).
4. **Webhooks + live data.** Subscribe to HighLevel webhooks (e.g. `ContactCreate`) and push them into the preview.
5. **Smarter context for large projects:** a file map plus a `read_file` tool, then import-graph selection, and embeddings only at thousands of files (DESIGN §15).

## Deployment notes

```bash
firebase use --add                                   # select your real project (Blaze plan required)
cp .env.example functions/.env                       # fill HL_CLIENT_ID, API_BASE_URL, APP_URL (MOCK_* = false)
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set HL_CLIENT_SECRET
firebase functions:secrets:set GEMINI_API_KEY   # fallback when Claude is unavailable (a placeholder disables the fallback)
cp .env.example frontend/.env                        # fill VITE_FIREBASE_* and VITE_API_BASE_URL
firebase deploy --only firestore,functions,hosting   # predeploy hooks build both packages
```

- **Cold starts:** `MIN_INSTANCES=1` in `functions/.env` keeps one instance warm while the app is under review (a few dollars a month). Set it to `0` and redeploy afterwards.
- Enable **Email/Password** sign-in in Firebase Console → Authentication.
- The first deploy prints the function URL. Set it as `API_BASE_URL` / `VITE_API_BASE_URL`, register `${API_BASE_URL}/oauth/callback` in HighLevel, and redeploy.
- `api` is one 2nd-gen HTTPS function (Cloud Run): 540 s timeout, streaming responses, secrets from Secret Manager. Before a demo, hit `/health` once to avoid a cold start.
- The frontend calls the function URL directly (not via a Hosting rewrite) so SSE isn't buffered.
- CI checks every push, but deploys are still manual (`firebase deploy`); CD with preview channels is the next step.
