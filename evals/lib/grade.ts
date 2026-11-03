import { FORBIDDEN_API, unknownHlOps } from '../../functions/src/generation/confidence'
import type { RenderResult } from './render'

/** USD per million tokens. Unknown models report tokens only. */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
}

export interface Case { id: string; kind: 'new' | 'refine' | 'negative'; steps: string[]; expectOps: string[]; expectText?: string[]; hlFail?: string }


export function grade(testCase: Case, status: string | null, files: Map<string, string>, render: RenderResult | null) {
  const code = [...files.values()].join('\n')
  const opUsed = (alt: string) => alt.split('|').some((op) => new RegExp(`hl\\.${op.replace('.', '\\.')}\\b`).test(code))
  const checks = {
    generated: status === 'complete',
    expectedOps: testCase.expectOps.every(opUsed),
    // Safe: no blocked browser APIs, no made-up hl operations, nothing the preview CSP had to block.
    noForbiddenApis: !FORBIDDEN_API.test(code) && unknownHlOps(code).length === 0 && (!render || render.violations.length === 0),
    handlesStates: /genesis\.useHl|errorText/.test(code),
    refinementApplied: (testCase.expectText ?? []).every((re) => new RegExp(re, 'i').test(code)),
    noRuntimeErrors: !!render && render.errors.length === 0,
    hlCallsOk: !!render && render.calls.length > 0 && render.calls.every((call) => call.ok),
    rendered: !!render && render.textLength > 40,
  }
  const weights: Record<keyof typeof checks, number> = {
    generated: 25, expectedOps: 10, noForbiddenApis: 5, handlesStates: 5, refinementApplied: 5,
    noRuntimeErrors: 25, hlCallsOk: 15, rendered: 10,
  }
  // A case that expects no particular ops (vague prompt) can pass hlCallsOk without calling HighLevel.
  if (testCase.expectOps.length === 0 && render && render.calls.every((call) => call.ok)) checks.hlCallsOk = true
  // HighLevel down: calls are meant to fail; passing means the app tried, kept running and showed something.
  if (testCase.hlFail) checks.hlCallsOk = !!render && render.calls.length > 0
  const score = (Object.keys(checks) as (keyof typeof checks)[]).reduce((sum, check) => sum + (checks[check] ? weights[check] : 0), 0)
  return { checks, score, pass: score >= 80 && checks.noRuntimeErrors }
}

export function cost(model: string | null, usage: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
  const price = model ? PRICES[model] : undefined
  if (!price) return null
  return (usage.input * price.input + usage.output * price.output + usage.cacheRead * price.cacheRead + usage.cacheWrite * price.cacheWrite) / 1e6
}

