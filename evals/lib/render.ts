import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { API } from './emulator'

/** Render check: runs the real preview build in headless Chrome and reports errors, hl calls and rendered text. */
export const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const RENDER_WAIT_MS = 6000

export interface RenderResult { errors: string[]; calls: { op: string; ok: boolean; code?: string }[]; violations: string[]; textLength: number }


/** Same policy as frontend/public/preview.html, except the harness may call its own /hl endpoint. */
const PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:; connect-src 'self'; form-action 'none'; base-uri 'none'"

/** In a top-level page window.parent === window, so the real window.hl runtime's requests are answered here. */
const HARNESS = String.raw`<script>
(function () {
  var out = { errors: [], calls: [], violations: [], textLength: 0 };
  window.addEventListener('error', function (event) { out.errors.push(String(event.message || event.type) + (event.filename ? ' @' + event.filename.split('/').pop() + ':' + event.lineno : '')); }, true);
  window.addEventListener('unhandledrejection', function (event) { var reason = event.reason; out.errors.push('unhandled: ' + ((reason && (reason.message || String(reason))) || 'rejection')); });
  document.addEventListener('securitypolicyviolation', function (event) { out.violations.push(event.violatedDirective + ' ' + event.blockedURI); });
  window.addEventListener('message', function (event) {
    var message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.__genesis === 'preview:error') out.errors.push(message.message);
    if (message.__genesis !== 'hl:request') return;
    fetch('/hl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: message.op, params: message.params }) })
      .then(function (response) { return response.json().then(function (body) { return { ok: response.ok, body: body }; }); })
      .then(function (reply) {
        out.calls.push({ op: message.op, ok: reply.ok, code: reply.ok ? undefined : reply.body && reply.body.error && reply.body.error.code });
        window.postMessage(reply.ok ? { __genesis: 'hl:response', id: message.id, ok: true, data: reply.body.data } : { __genesis: 'hl:response', id: message.id, ok: false, error: reply.body && reply.body.error }, '*');
      });
  });
  window.addEventListener('load', function () {
    setTimeout(function () {
      out.textLength = (document.body && document.body.innerText.trim().length) || 0;
      fetch('/result', { method: 'POST', body: JSON.stringify(out) });
    }, ${RENDER_WAIT_MS});
  });
})();
</script>`

export async function renderCheck(html: string, cookie: string, hlFail?: string): Promise<RenderResult> {
  const page = html.replace(/<head[^>]*>/i, (headTag) => `${headTag}\n${HARNESS}`)
  let resolve!: (renderResult: RenderResult) => void
  const result = new Promise<RenderResult>((resolveResult) => (resolve = resolveResult))
  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((resolveBody) => { let collected = ''; req.on('data', (chunk) => (collected += chunk)); req.on('end', () => resolveBody(collected)) })
    if (req.url === '/hl' && hlFail) {
      // Negative case: HighLevel is down. The app should show its error state, not crash.
      res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: hlFail, message: 'HighLevel is having trouble right now.', retryable: true } }))
    } else if (req.url === '/hl') {
      const upstream = await fetch(`${API}/api/hl/call`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body })
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(await upstream.text())
    } else if (req.url === '/result') {
      res.end('ok')
      resolve(JSON.parse(body))
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_CSP }).end(page)
    }
  })
  await new Promise<void>((onListening) => server.listen(0, '127.0.0.1', onListening))
  const port = (server.address() as { port: number }).port
  const profile = mkdtempSync(join(tmpdir(), 'genesis-eval-'))
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: 'ignore' })
  const timeout = new Promise<RenderResult>((resolveTimeout) => setTimeout(() => resolveTimeout({ errors: ['render timed out'], calls: [], violations: [], textLength: 0 }), RENDER_WAIT_MS + 20_000))
  try {
    return await Promise.race([result, timeout])
  } finally {
    chrome.kill()
    server.close()
  }
}

