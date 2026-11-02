# Evals

Measures whether generated apps actually work, using checks we can run instead of asking the model how confident it is.

```
cases.json ──▶ per case: fresh user + project ──▶ POST /generate (real model, mock HighLevel data)
                                                         │
             ┌───────────────────────────────────────────┘
             ▼
 generated (25)  finished `complete`: parsed and passed validation
 static    (25)  expected window.hl ops used · no fetch/localStorage/window.parent ·
                 loading/error handled (genesis.useHl) · refinement text present
 render    (50)  headless Chrome runs the real preview build (starter kit + window.hl
                 runtime + preview CSP): no runtime errors · every hl call succeeds ·
                 something rendered
             │
             ▼
 health score 0–100 · pass = score ≥ 80 and no runtime errors
 + tokens, TTFT, duration, edit stats (applied/failed/repaired), cost when the model has a price
```

The health score is the per-generation confidence signal. Calibrating it against the pass rate is what lets the product later say "score ≥ 80 means the app almost always works".

## Run

Emulators with `MOCK_LLM=false`, `MOCK_HL=true` (`functions/.env.local`), then:

```bash
frontend/node_modules/.bin/jiti evals/run.ts              # all cases
frontend/node_modules/.bin/jiti evals/run.ts kpi-overview # one case
```

Results: `evals/results/latest.md` (table) and a timestamped JSON with every check, render error, HL call and token count.

Every run spends real model tokens. With Claude Opus 5.5 ($4 / $20 per MTok) a case costs a few cents; the report prints the measured $/case.

## Cases

12 cases: 9 new apps across contacts, conversations and calendars (including a write flow and a deliberately vague prompt) and 3 two-step refinements that exercise search/replace edits. Add a case by appending to `cases.json`.

## When to run

On every change to the system prompt, the window.hl spec, the starter kit or the model. Compare pass rate, mean score and output tokens against the previous `latest.md` before shipping.
