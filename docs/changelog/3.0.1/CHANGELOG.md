# v3.0.1 (2026-03-06)

Backlog clearance: backfill pre-filter fix (H1), toxic-border test stabilization (M1), repomix snapshot correction (L1), KV sync investigation (L2).

## Fixes

| ID | Title | Commit | Notes |
|----|---------|---------|----- |
| H1 | `--backfill` session pre-filter can skip missing metric gaps | [e647e7e](https://github.com/aledlie/quality-metrics-dashboard/commit/e647e7e) | Broadened pre-filter to check all seed metrics, not just hallucination. Fixes incomplete evaluation coverage in backfill mode. |
| M1 | Correlation toxic-border test is brittle after CSS var refactor | [73c2da5](https://github.com/aledlie/quality-metrics-dashboard/commit/73c2da5) | Repaired TIME_MS imports and stabilized toxic-cell assertion to work with CSS variable-based border values. |
| L1 | Repomix snapshot shows invalid `const TIME_MS.DAY` syntax | [b2c36d5](https://github.com/aledlie/quality-metrics-dashboard/commit/b2c36d5) | Regenerated `docs/repomix/docs.xml` from current source; invalid `const TIME_MS.DAY = ...` syntax now correctly shows `const TIME_MS = { ... }` object form. |
| L2 | KV sync coverage trace count decreased without explanation | Investigation | Trace count decrease (84,573 → 79,097 → 77,856) is expected behavior; `sync-to-kv.ts` uses `--days=30` rolling window, old traces rotate out naturally. No data loss. |

## Summary

- **Items resolved**: 4 (H1, M1, L1, L2)
- **Commits**: 2 (e647e7e, 73c2da5; L1 regeneration b2c36d5; backlog updates c06482f)
- **Code changes**: H1 (scripts fix), M1 (test fix); L1/L2 documentation-only
