# Dashboard Backlog

Open items from code reviews and deferred work.

**Resolved items**: [v2.29 DRY Backlog H1–L6](changelog/2.29/CHANGELOG.md) (2026-03-01) | [v2.28 Theme CSS DRY](changelog/2.28/CHANGELOG.md) (2026-02-28) | [DRY pages/ refactor](changelog/2.28/CHANGELOG.md) (2026-02-28)

> All 10 DRY review items (H1–H3, M4–M7, L8–L10) were implemented and committed 2026-02-28.
> See commits 7084538 and bb7f141.

> All 14 DRY backlog items (H1, H4, H5, M3–M6, M8, L1–L6) were implemented 2026-03-01 and migrated to [v2.29 changelog](changelog/2.29/CHANGELOG.md).
> Session aaf11fa follow-up; commits ea59b38–285a533.

## Open Items

_None — all Final Review Follow-ups resolved 2026-03-01._

### Final Review Follow-ups (2026-03-01) — Done

| ID | File | Issue | Resolution |
|----|------|-------|------------|
| FR1 | `TrendChart.tsx` | Remove redundant `COLORS` alias | Done — 1424c9d |
| FR2 | `useApiQuery.ts` | Document `buildUrl`/`enabled` contract | Done — d3c8d16 |
| FR3 | `Stat.tsx` | Move magic number styles to theme.css | Done — 371f663 |
| FR4 | `TruncatedList.tsx` | JSDoc note: `renderItem` must provide `key` | Done — 443996b |
| FR5 | `TrendChart.tsx` | Add `role="img"` to aria-label container | Done — 5554948 |
| FR6 | `FreqBar.tsx` | Replace hardcoded widths with CSS grid | Done — d66fac9 |
| FR7 | `MetadataRow.tsx` | Suppress empty-string values same as null | Done — 76d7e4b |
| FR8 | `TrendSeries.tsx` | Replace `#0d1117` with `--bg-card` hex + `role="img"` | Done — c2ab8a6, 604e236 |
