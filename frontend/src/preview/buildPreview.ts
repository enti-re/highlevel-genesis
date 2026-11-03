import { HL_RUNTIME } from './hlRuntime'
import { KIT_DUPLICATE_SCRIPT, KIT_HEAD } from './starterKit'

const isLocal = (url: string) => !/^(https?:)?\/\//i.test(url) && !url.startsWith('data:')
const normalize = (url: string) => url.replace(/^\.\//, '').split(/[?#]/)[0]
/** Prevents file content from closing the inline tag early. */
const escapeScript = (code: string) => code.replace(/<\/script/gi, '<\\/script')
const escapeStyle = (css: string) => css.replace(/<\/style/gi, '<\\/style')

/** Project files -> one HTML page for /preview.html: local scripts and styles inlined, kit and window.hl injected first. */
export function buildPreviewHtml(files: Map<string, string>): { html: string; missing: string[] } {
  const missing: string[] = []
  const entry = files.get('index.html')
  if (!entry) {
    return {
      html: `<!doctype html><html><body style="font-family:system-ui;color:#71717a;display:grid;place-items:center;height:100vh;margin:0">
        <p>No index.html yet. Describe an app in the chat to generate one.</p></body></html>`,
      missing,
    }
  }

  let html = entry
    .replace(KIT_DUPLICATE_SCRIPT, '<!-- provided by the starter kit -->')
    .replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, before: string, src: string, after: string) => {
      if (!isLocal(src)) return tag
      const code = files.get(normalize(src))
      if (code === undefined) {
        missing.push(normalize(src))
        return `<!-- missing ${src} -->`
      }
      return `<script${before}${after}>\n${escapeScript(code)}\n</script>`
    })

  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!href || !isLocal(href)) return tag
    const css = files.get(normalize(href))
    if (css === undefined) {
      missing.push(normalize(href))
      return `<!-- missing ${href} -->`
    }
    return `<style>\n${escapeStyle(css)}\n</style>`
  })

  // Kit first (Vue, Tailwind, theme, helpers), then the window.hl bridge, then the app's own head.
  const runtime = `${KIT_HEAD}\n<script>${HL_RUNTIME}</script>`
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (openTag) => `${openTag}\n${runtime}`)
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (openTag) => `${openTag}<head>${runtime}</head>`)
  else html = runtime + html

  return { html, missing }
}
