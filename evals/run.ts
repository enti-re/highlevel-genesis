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
const selected = only.length ? cases.filter((testCase) => only.includes(testCase.id)) : cases
async function runCase(testCase: Case) {
  const user = await newUser()
  const projectId = await newProject(user.token, user.uid, `eval ${testCase.id}`)
  const gens: (Awaited<ReturnType<typeof loadGeneration>> | null)[] = []
  let last: Awaited<ReturnType<typeof generate>> | null = null
  for (const prompt of testCase.steps) {
    last = await generate(user.token, projectId, prompt)
    gens.push(last.generationId ? await loadGeneration(projectId, last.generationId) : null)
    if (last.end.event !== 'done') break
  }
  const status = last?.end.event === 'done' ? last.end.data.status : null
  const files = await loadFiles(projectId)
  const { html, missing } = files.size ? buildPreviewHtml(files) : { html: '', missing: [] }
  const render = html ? await renderCheck(html, user.cookie, testCase.hlFail) : null
  const graded = grade(testCase, status, files, render)
  const usage = gens.reduce((total, generation) => generation ? { input: total.input + generation.usage.input, output: total.output + generation.usage.output, cacheRead: total.cacheRead + generation.usage.cacheRead, cacheWrite: total.cacheWrite + generation.usage.cacheWrite } : total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  const model = gens.find((generation) => generation?.model)?.model ?? null
  const promptVersion = gens.find((generation) => generation?.promptVersion)?.promptVersion ?? null
  const row = {
    id: testCase.id, kind: testCase.kind, ...graded, status, error: last?.end.event === 'error' ? last.end.data.code : null,
    model, promptVersion, usage, costUsd: cost(model, usage), confidence: gens[gens.length - 1]?.confidence ?? null,
    ttftMs: gens[gens.length - 1]?.ttftMs ?? null, durationMs: gens.reduce((sum, generation) => sum + (generation?.durationMs ?? 0), 0),
    edits: gens.reduce((total, generation) => generation ? { applied: total.applied + generation.edits.applied, failed: total.failed + generation.edits.failed, repaired: total.repaired + generation.edits.repaired } : total, { applied: 0, failed: 0, repaired: 0 }),
    render: render && { ...render, missingFiles: missing },
  }
  return row
}

const results: Awaited<ReturnType<typeof runCase>>[] = []
for (const testCase of selected) {
  process.stdout.write(`${testCase.id.padEnd(24)} `)
  const row = await runCase(testCase)
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'}  score ${String(row.score).padStart(3)}  ${row.error ?? ''} ${row.render?.errors.slice(0, 1).join('') ?? ''}`)
}

// Provider outages and quota errors say nothing about app quality: report them, but keep them out of every rate.
const INFRA = new Set(['LLM_RATE_LIMITED', 'LLM_UNAVAILABLE', 'LLM_CONNECTION', 'LLM_CONFIG', 'TIMEOUT'])
const infraErrors = results.filter((row) => row.error && INFRA.has(row.error))
const graded = results.filter((row) => !(row.error && INFRA.has(row.error)))

const pct = (xs: number[], percentile: number) => { const sorted = [...xs].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(percentile * sorted.length))] : 0 }
const passed = graded.filter((row) => row.pass).length
const durations = graded.map((row) => row.durationMs)
const ttfts = graded.map((row) => row.ttftMs ?? 0).filter(Boolean)
const costs = graded.map((row) => row.costUsd).filter((caseCost): caseCost is number => caseCost !== null)
const summary = {
  ranAt: new Date().toISOString(),
  promptVersion: results.find((row) => row.promptVersion)?.promptVersion ?? null, model: results.find((row) => row.model)?.model ?? null,
  passRate: `${passed}/${graded.length}`, meanScore: Math.round(graded.reduce((sum, row) => sum + row.score, 0) / Math.max(1, graded.length)),
  infraErrors: infraErrors.map((row) => `${row.id}: ${row.error}`),
  ttftP50Ms: pct(ttfts, 0.5), durationP50Ms: pct(durations, 0.5), durationP95Ms: pct(durations, 0.95),
  outputTokensMean: Math.round(graded.reduce((sum, row) => sum + row.usage.output, 0) / Math.max(1, graded.length)),
  costPerCaseUsd: costs.length ? +(costs.reduce((sum, caseCost) => sum + caseCost, 0) / costs.length).toFixed(4) : null,
}

// Calibration: does the server's confidence score (computed without running the app)
// predict whether the app actually works in the browser?
const works = (row: (typeof results)[number]) => row.checks.noRuntimeErrors && row.checks.rendered && row.checks.hlCallsOk
const buckets = [['high (≥80)', 80, 101], ['medium (50–79)', 50, 80], ['low (<50)', 0, 50]] as const
const calibration = buckets.map(([label, lo, hi]) => {
  const inBucket = graded.filter((row) => row.confidence !== null && row.confidence >= lo && row.confidence < hi)
  return { bucket: label, cases: inBucket.length, worksRate: inBucket.length ? Math.round((100 * inBucket.filter(works).length) / inBucket.length) : null }
})

const outDir = join(HERE, 'results')
mkdirSync(outDir, { recursive: true })
const stamp = summary.ranAt.replace(/[:.]/g, '-')
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ summary, calibration, results }, null, 2))

const yes = (passed: boolean) => (passed ? '✓' : '✗')
const md = [
  `# Eval run ${summary.ranAt}`,
  '',
  `Model: \`${summary.model ?? 'unknown'}\` · prompt \`${summary.promptVersion ?? '?'}\` · pass ${summary.passRate} · mean score ${summary.meanScore} · TTFT p50 ${summary.ttftP50Ms} ms · duration p50/p95 ${summary.durationP50Ms}/${summary.durationP95Ms} ms · mean output tokens ${summary.outputTokensMean}${summary.costPerCaseUsd !== null ? ` · ~$${summary.costPerCaseUsd}/case` : ''}`,
  '',
  ...(infraErrors.length ? [`> Not graded (provider error, not app quality): ${summary.infraErrors.join(', ')}`, ''] : []),
  '| case | score | confidence | gen | ops | safe | states | refine | no errors | hl ok | rendered | edits a/f/r | notes |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...graded.map((row) => `| ${row.id} | ${row.score}${row.pass ? '' : ' ❌'} | ${row.confidence ?? '–'} | ${yes(row.checks.generated)} | ${yes(row.checks.expectedOps)} | ${yes(row.checks.noForbiddenApis)} | ${yes(row.checks.handlesStates)} | ${yes(row.checks.refinementApplied)} | ${yes(row.checks.noRuntimeErrors)} | ${yes(row.checks.hlCallsOk)} | ${yes(row.checks.rendered)} | ${row.edits.applied}/${row.edits.failed}/${row.edits.repaired} | ${[row.error, ...(row.render?.errors ?? []).slice(0, 1)].filter(Boolean).join('; ').replace(/\|/g, '/').slice(0, 120)} |`),
  '',
  '## Calibration: server confidence vs. app actually works in the browser',
  '',
  '| confidence | cases | works |',
  '|---|---|---|',
  ...calibration.map((bucket) => `| ${bucket.bucket} | ${bucket.cases} | ${bucket.worksRate === null ? '–' : `${bucket.worksRate}%`} |`),
  '',
].join('\n')
writeFileSync(join(outDir, 'latest.md'), md)
console.log(`\n${JSON.stringify(summary)}\nwrote evals/results/${stamp}.json and evals/results/latest.md`)
process.exit(0)
