# 3.0.14 Changelog

Released 2026-11-22

> 1 completed item migrated from `BACKLOG.md`. Each row is the entry's own backlog text, copied verbatim.

## Completed

| ID | Title | Description |
|----|-------|-------------|
| DASH-TEST-CLOSE-TO-DIGITS-SUPPORT | Done 2026-11-22 — Move the 10-digit `toBeCloseTo` precision into `scripts/__tests__/support/` | `COST_CLOSE_TO_DIGITS` is exported from `support/fixtures.ts`; `npm run test:scripts` green (924 tests). The same 10-digit precision is declared under two names in three files: `COST_CLOSE_TO_DIGITS` in `judge-consolidated-batch.test.ts` (module scope) and `judge-evaluations.test.ts` (inside a `describe`), and `USD_PRECISION_DIGITS` in `judge-quality-eval.test.ts`. The judge-suite audit flagged it as the one constant that belongs in `support/`, which the magic-number sweep was told not to touch. Acceptance: one exported constant in `scripts/__tests__/support/`, the three local copies gone, and `npm run test:scripts` green. |
