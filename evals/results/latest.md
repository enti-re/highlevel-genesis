# Eval results so far

Real-model runs on the local emulator (`gemini-3.5-flash`, mock HighLevel data). The Claude (`claude-opus-5-5`) run happens after deploy; it will replace this file with the full table, cost per case and calibration.

| Run | Graded | Pass | Notes |
|---|---|---|---|
| 1 (`2026-11-02T11-59-15-483Z.json`) | 12 | 9 (75%) | All 3 failures were one bug class: a backtick inside the Vue template string made `app.js` a syntax error (blank app). Fixed with a prompt rule, a server-side syntax check and one bounded repair call. |
| 2 (`2026-11-02T17-28-34-035Z.json`) | 5 | 5 (100%) | Includes `new-contact-form`, which failed in run 1. The other 10 cases hit the Gemini free-tier quota (`LLM_RATE_LIMITED`); the harness now reports those as not graded instead of failures. |

Calibration so far (run 2): confidence ≥ 80 → 5/5 apps rendered and worked.
