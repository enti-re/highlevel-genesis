import { describe, expect, it } from 'vitest'
import { buildPreviewHtml } from './buildPreview'
import { KIT_VERSIONS } from './starterKit'

const files = (entries: Record<string, string>) => new Map(Object.entries(entries))

describe('buildPreviewHtml', () => {
  it('shows a placeholder when there is no index.html', () => {
    const { html } = buildPreviewHtml(files({ 'app.js': '1' }))
    expect(html).toContain('No index.html yet')
  })

  it('inlines local scripts and stylesheets in order, keeps external ones', () => {
    const { html, missing } = buildPreviewHtml(
      files({
        'index.html': `<html><head><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="https://x.com/a.css"></head>
          <body><script src="./components/a.js"></script><script src="app.js"></script><script src="https://cdn.x/lib.js"></script></body></html>`,
        'styles.css': 'body{color:red}',
        'components/a.js': 'window.A=1',
        'app.js': 'console.log(A)',
      }),
    )
    expect(missing).toEqual([])
    expect(html).toContain('<style>\nbody{color:red}\n</style>')
    expect(html).toContain('href="https://x.com/a.css"')
    expect(html.indexOf('window.A=1')).toBeLessThan(html.indexOf('console.log(A)'))
    expect(html).toContain('src="https://cdn.x/lib.js"')
  })

  it('injects the starter kit and hl runtime at the top of <head>', () => {
    const { html } = buildPreviewHtml(files({ 'index.html': '<html><head><title>x</title></head><body></body></html>' }))
    const head = html.slice(0, html.indexOf('<title>'))
    expect(head).toContain(`vue@${KIT_VERSIONS.vue}`)
    expect(head).toContain(`@tailwindcss/browser@${KIT_VERSIONS.tailwind}`)
    expect(head).toContain('window.genesis')
    expect(head).toContain('window.hl')
  })

  it('strips a second copy of Vue/Tailwind added by the model (two Vue instances break reactivity)', () => {
    const { html } = buildPreviewHtml(
      files({
        'index.html': `<head></head><body><script src="https://unpkg.com/vue@3.5.13/dist/vue.global.prod.js"></script>
          <script src="https://cdn.tailwindcss.com"></script></body>`,
      }),
    )
    expect(html).not.toContain('vue@3.5.13')
    expect(html).not.toContain('cdn.tailwindcss.com')
    expect(html.match(/vue\.global\.prod\.js/g)).toHaveLength(1) // only the kit's copy
  })

  it('escapes </script> inside inlined code so it cannot close the tag early', () => {
    const { html } = buildPreviewHtml(
      files({ 'index.html': '<head></head><script src="app.js"></script>', 'app.js': 'const s = "</script>";' }),
    )
    expect(html).toContain('const s = "<\\/script>";')
  })

  it('reports referenced files that do not exist', () => {
    const { missing } = buildPreviewHtml(files({ 'index.html': '<head></head><script src="nope.js"></script>' }))
    expect(missing).toEqual(['nope.js'])
  })
})
