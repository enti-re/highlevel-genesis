/**
 * Eval harness: runs cases.json through the real /generate pipeline and grades the apps
 * (generation, static checks, headless-Chrome render). See evals/README.md.
 * Run: frontend/node_modules/.bin/jiti evals/run.ts [caseId ...]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPreviewHtml } from '../frontend/src/preview/buildPreview'
import { generate, loadFiles, loadGeneration, newProject, newUser } from './lib/emulator'
import { type Case, cost, grade } from './lib/grade'
import { renderCheck } from './lib/render'

const HERE = dirname(fileURLToPath(import.meta.url))

const { cases } = JSON.parse(readFileSync(join(HERE, 'cases.json'), 'utf8')) as { cases: Case[] }
const only = process.argv.slice(2)
const selected = only.length ? cases.filter((c) => only.includes(c.id)) : cases
async function runCase(c: Case) {
  const user = await newUser()
  const projectId = await newProject(user.token, user.uid, `eval ${c.id}`)
  const gens: (Awaited<ReturnType<typeof loadGeneration>> | null)[] = []
  let last: Awaited<ReturnType<typeof generate>> | null = null
  for (const prompt of c.steps) {
    last = await generate(user.token, projectId, prompt)
    gens.push(last.generationId ? await loadGeneration(projectId, last.generationId) : null)
    if (last.end.event !== 'done') break
  }
  const status = last?.end.event === 'done' ? last.end.data.status : null
  const files = await loadFiles(projectId)
  const { html, missing } = files.size ? buildPreviewHtml(files) : { html: '', missing: [] }
  const render = html ? await renderCheck(html, user.cookie, c.hlFail) : null
  const graded = grade(c, status, files, render)
  const usage = gens.reduce((a, g) => g ? { input: a.input + g.usage.input, output: a.output + g.usage.output, cacheRead: a.cacheRead + g.usage.cacheRead, cacheWrite: a.cacheWrite + g.usage.cacheWrite } : a, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const model = gens.find((g) => g?.model)?.model ?? null
  const promptVersion = gens.find((g) => g?.promptVersion)?.promptVersion ?? null
  const row = {
    id: c.id, kind: c.kind, ...graded, status, error: last?.end.event === 'error' ? last.end.data.code : null,
    model, promptVersion, usage, costUsd: cost(model, usage), confidence: gens[gens.length - 1]?.confidence ?? null,
    ttftMs: gens[gens.length - 1]?.ttftMs ?? null, durationMs: gens.reduce((s, g) => s + (g?.durationMs ?? 0), 0),
    edits: gens.reduce((a, g) => g ? { applied: a.applied + g.edits.applied, failed: a.failed + g.edits.failed, repaired: a.repaired + g.edits.repaired } : a, { applied: 0, failed: 0, repaired: 0 }),
    render: render && { ...render, missingFiles: missing },
  }
  return row
}

const results: Awaited<ReturnType<typeof runCase>>[] = []
for (const c of selected) {
  process.stdout.write(`${c.id.padEnd(24)} `)
  const row = await runCase(c)
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  score ${String(row.score).padStart(3)}  ${row.error ?? ''} ${row.render?.errors.slice(0, 1).join('') ?? ''}`)
}

// Provider outages and quota errors say nothing about app quality: report them, but keep them out of every rate.
const INFRA = new Set(['LLM_RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_CONNECTION', 'LLM_CONFIG', 'TIMEOUT'])
const infraErrors = results.filter((r) => r.error && INFRA.has(r.error))
const graded = results.filter((r) => !(r.error && INFRA.has(r.error)))

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const passed = graded.filter((r) => r.pass).length
const durations = graded.map((r) => r.durationMs)
const ttfts = graded.map((r) => r.ttftMs ?? 0).filter(Boolean)
const costs = graded.map((r) => r.costUsd).filter((x): x is number => x !== null)
const summary = {
  ranAt: new Date().toISOString(),
  promptVersion: results.find((r) => r.promptVersion)?.promptVersion ?? null, model: results.find((r) => r.model)?.model ?? null,
  passRate: `${passed}/${graded.length}`, meanScore: Math.round(graded.reduce((s, r) => s + r.score, 0) / Math.max(1, graded.length)),
  infraErrors: infraErrors.map((r) => `${r.id}: ${r.error}`),
  ttftP50Ms: pct(ttfts, 0.5), durationP50Ms: pct(durations, 0.5), durationP95Ms: pct(durations, 0.95),
  outputTokensMean: Math.round(graded.reduce((s, r) => s + r.usage.output, 0) / Math.max(1, graded.length)),
  costPerCaseUsd: costs.length ? +(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4) : null,
}

// Calibration: does the server's confidence score (computed without running the app)
// predict whether the app actually works in the browser?
const works = (r: (typeof results)[number]) => r.checks.noRuntimeErrors && r.checks.rendered && r.checks.hlCallsOk
const buckets = [['high (≥80)', 80, 101], ['medium (50–79)', 50, 80], ['low (<50)', 0, 50]] as const
const calibration = buckets.map(([label, lo, hi]) => {
  const inBucket = graded.filter((r) => r.confidence !== null && r.confidence >= lo && r.confidence < hi)
  return { bucket: label, cases: inBucket.length, worksRate: inBucket.length ? Math.round((100 * inBucket.filter(works).length) / inBucket.length) : null }
})

const outDir = join(HERE, 'results')
mkdirSync(outDir, { recursive: true })
const stamp = summary.ranAt.replace(/[:.]/g, '-')
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ summary, calibration, results }, null, 2))

const yes = (b: boolean) => (b ? '✓' : '✗')
const md = [
  `# Eval run ${summary.ranAt}`,
  '',
  `Model: \`${summary.model ?? 'unknown'}\` · prompt \`${summary.promptVersion ?? '?'}\` · pass ${summary.passRate} · mean score ${summary.meanScore} · TTFT p50 ${summary.ttftP50Ms} ms · duration p50/p95 ${summary.durationP50Ms}/${summary.durationP95Ms} ms · mean output tokens ${summary.outputTokensMean}${summary.costPerCaseUsd !== null ? ` · ~$${summary.costPerCaseUsd}/case` : ''}`,
  '',
  ...(infraErrors.length ? [`> Not graded (provider error, not app quality): ${summary.infraErrors.join(', ')}`, ''] : []),
  '| case | score | confidence | gen | ops | safe | states | refine | no errors | hl ok | rendered | edits a/f/r | notes |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...graded.map((r) => `| ${r.id} | ${r.score}${r.pass ? '' : ' ❌'} | ${r.confidence ?? '–'} | ${yes(r.checks.generated)} | ${yes(r.checks.expectedOps)} | ${yes(r.checks.noForbiddenApis)} | ${yes(r.checks.handlesStates)} | ${yes(r.checks.refinementApplied)} | ${yes(r.checks.noRuntimeErrors)} | ${yes(r.checks.hlCallsOk)} | ${yes(r.checks.rendered)} | ${r.edits.applied}/${r.edits.failed}/${r.edits.repaired} | ${[r.error, ...(r.render?.errors ?? []).slice(0, 1)].filter(Boolean).join('; ').replace(/\|/g, '/').slice(0, 120)} |`),
  '',
  '## Calibration: server confidence vs. app actually works in the browser',
  '',
  '| confidence | cases | works |',
  '|---|---|---|',
  ...calibration.map((b) => `| ${b.bucket} | ${b.cases} | ${b.worksRate === null ? '–' : `${b.worksRate}%`} |`),
  '',
].join('\n')
writeFileSync(join(outDir, 'latest.md'), md)
console.log(`\n${JSON.stringify(summary)}\nwrote evals/results/${stamp}.json and evals/results/latest.md`)
process.exit(0)
