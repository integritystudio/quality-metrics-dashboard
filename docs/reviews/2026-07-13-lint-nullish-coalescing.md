# OTel Hooks Code Review — 2026-07-13

Review of the OBP7b canonical-key cutover (dc644ac, f0a6547): attribute-alias system removal, single-query agents route, and the state of `src/` after the refactor.

## Open Items

*(none)*

## Completed

### Lint errors — `prefer-nullish-coalescing` in `src/` strict zone (LINT-1)

**Priority**: P2 | **Source**: `npm run lint`

11 errors across 7 files in the `src/` directory (strict enforcement zone — errors, not warnings). The ESLint rule `@typescript-eslint/prefer-nullish-coalescing` flags `||` where operands can be `undefined`. Two categories:

**Category A — env/query fallback (should use `??` or disable comment):**
- `src/api/server.ts:20` — `process.env.CORS_ORIGIN || 'http://localhost:5173'` → safe to use `??`
- `src/api/routes/dashboard.ts:42` — `c.req.query('role') || undefined` → intentional empty-string coercion; needs ESLint disable comment
- `src/api/routes/metrics.ts:106` — `c.req.query('scoreLabel') || undefined` → same

**Category B — boolean-intent guards used in JSX `{expr && (...)}` (explicit null-check fixes):**
- `src/components/DetailPageHeader.tsx:10` — `id || children` → `id != null || children != null`
- `src/components/EvaluationExpandedRow.tsx:50` — `row.explanation || meta.length > 0 || ...` → `!!row.explanation || meta.length > 0 || ...`
- `src/components/EvaluationExpandedRow.tsx:97` — `row.traceId || row.sessionId` → `row.traceId != null || row.sessionId != null`
- `src/components/ScoreBadge.tsx:63` — `evaluator || evaluatorType || explanation || traceId` → explicit `!= null` checks
- `src/pages/CorrelationsPage.tsx:44` — `leftMetric || rightMetric` → `leftMetric != null || rightMetric != null`

**Fix:** address all 11 in a single commit; verify `npm run lint` exits clean.

**Status:** Done — 0 errors remain (`npm run lint` exits with 0 errors, 274 warnings in test/scripts warning zones).
