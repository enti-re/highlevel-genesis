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
  window.addEventListener('error', function (e) { out.errors.push(String(e.message || e.type) + (e.filename ? ' @' + e.filename.split('/').pop() + ':' + e.lineno : '')); }, true);
  window.addEventListener('unhandledrejection', function (e) { var r = e.reason; out.errors.push('unhandled: ' + ((r && (r.message || String(r))) || 'rejection')); });
  document.addEventListener('securitypolicyviolation', function (e) { out.violations.push(e.violatedDirective + ' ' + e.blockedURI); });
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.__genesis === 'preview:error') out.errors.push(m.message);
    if (m.__genesis !== 'hl:request') return;
    fetch('/hl', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: m.op, params: m.params }) })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); })
      .then(function (x) {
        out.calls.push({ op: m.op, ok: x.ok, code: x.ok ? undefined : x.b && x.b.error && x.b.error.code });
        window.postMessage(x.ok ? { __genesis: 'hl:response', id: m.id, ok: true, data: x.b.data } : { __genesis: 'hl:response', id: m.id, ok: false, error: x.b && x.b.error }, '*');
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
  const page = html.replace(/<head[^>]*>/i, (m) => `${m}\n${HARNESS}`)
  let resolve!: (r: RenderResult) => void
  const result = new Promise<RenderResult>((r) => (resolve = r))
  const server = createServer(async (req, res) => {
    const body = await new Promise<string>((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)) })
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
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const profile = mkdtempSync(join(tmpdir(), 'genesis-eval-'))
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/`], { stdio: 'ignore' })
  const timeout = new Promise<RenderResult>((r) => setTimeout(() => r({ errors: ['render timed out'], calls: [], violations: [], textLength: 0 }), RENDER_WAIT_MS + 20_000))
  try {
    return await Promise.race([result, timeout])
  } finally {
    chrome.kill()
    server.close()
  }
}

