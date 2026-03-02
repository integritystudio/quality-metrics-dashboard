# Dashboard Backlog

Open items from code reviews and deferred work.

**Resolved items**: [v2.29 DRY Backlog H1–L6](changelog/2.29/CHANGELOG.md) (2026-03-01) | [v2.28 Theme CSS DRY](changelog/2.28/CHANGELOG.md) (2026-02-28) | [DRY pages/ refactor](changelog/2.28/CHANGELOG.md) (2026-02-28)

> All 10 DRY review items (H1–H3, M4–M7, L8–L10) were implemented and committed 2026-02-28.
> See commits 7084538 and bb7f141.

> All 14 DRY backlog items (H1, H4, H5, M3–M6, M8, L1–L6) were implemented 2026-03-01 and migrated to [v2.29 changelog](changelog/2.29/CHANGELOG.md).
> Session aaf11fa follow-up; commits ea59b38–285a533.

## Open Items

### Final Review Follow-ups (2026-03-01)

| ID | File | Issue | Priority |
|----|------|-------|----------|
| FR1 | `TrendChart.tsx` | Remove redundant `const COLORS = { ...CHART_COLORS, projection: CHART_COLORS.line }` — `projection` equals `CHART_COLORS.line`; reference `CHART_COLORS` directly in JSX | Low |
| FR2 | `useApiQuery.ts` | `buildUrl` / `enabled` coupling is implicit — callers using `traceId!` in buildUrl rely on `enabled: !!traceId` to prevent execution. Document contract in JSDoc or accept `url: string \| null` to derive enabled | Low |
| FR3 | `Stat.tsx` | Magic numbers: `fontSize: 22`, `minWidth: 80`, `marginTop: 3`, `lineHeight: 1.1`, `letterSpacing: '0.1em'`. Move stat value styles to `theme.css` classes | Low |
| FR4 | `TruncatedList.tsx` | Add JSDoc note: `renderItem` must return an element with a `key` prop | Low |
| FR5 | `TrendChart.tsx` | `aria-label` on inner `div` without `role`; add `role="img"` to the labelled container (matches TrendSeries pattern) | Low |
| FR6 | `FreqBar.tsx` | Hardcoded widths `160` / `36` for label and count columns; accept `labelWidth` prop or use CSS grid | Low |
| FR7 | `MetadataRow.tsx` | `value == null` guard allows empty string to render a blank row — consider `if (value == null \|\| value === '') return null` | Low |
| FR8 | `TrendSeries.tsx` | `background: '#0d1117'` duplicates page background hex; use `var(--bg-page)` so dark-mode variants stay consistent | Low |
