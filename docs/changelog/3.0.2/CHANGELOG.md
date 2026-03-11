# v3.0.2 (2026-03-11)

Backlog clearance: API parameter validation UX improvement (L1), React strict-mode compliance (L2), security hardening (L3).

## Fixes

| ID | Title | Commit | Notes |
|----|----------|---------|-------|
| L1 | Lower `PARAM_ID_RE` min length from 4 to 2 for better UX | [08644b0](https://github.com/aledlie/quality-metrics-dashboard/commit/08644b0) | Aligned minimum length with `PARAM_METRIC_NAME_RE` to prevent cryptic "Invalid format" errors for short IDs. Both now accept min 2 characters. |
| L2 | Move `actionRef` mutation in `useShortcut` to `useEffect` | [a9d2ab4](https://github.com/aledlie/quality-metrics-dashboard/commit/a9d2ab4) | Fixed React strict-mode violation where ref mutation occurred during render. Moved to effect-based assignment for safe, idempotent behavior. |
| L3 | Omit env var value from CORS validation error message | [1103280](https://github.com/aledlie/quality-metrics-dashboard/commit/1103280) | Removed raw `CORS_ORIGIN` value from error message to prevent exposure of potentially sensitive internal URLs. |

## Summary

- **Items resolved**: 3 (L1, L2, L3)
- **Commits**: 3 (08644b0, a9d2ab4, 1103280; backlog updates 885472f, 2287b10)
- **Code changes**: L1 (API constants), L2 (keyboard context), L3 (server config)
- **Test coverage**: All changes pass `npx tsc --noEmit`
- **Review score**: 8/10 (minor findings deferred to M1, L4, L5, L6)
