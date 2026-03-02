# v2.29 — DRY Backlog Completion

**Date**: 2026-03-01

## HIGH Priority (H1, H4, H5)

### H1: Consolidate status color mapping with data-attribute selectors

| Item | Resolution | Source |
|------|-----------|--------|
| H1 | CSS data-attribute selector pattern `[data-status="healthy/warning/critical/no_data/info"]` with shared CSS variables (`--s-bg`, `--s-border`, `--s-fg`). Replaced 10+ per-component status class rules in theme.css. Updated 5 files (Indicators, AlertList, HealthOverview, ExecutiveView, OperatorView) to use `data-status={status}` attribute. | Session aaf11fa follow-up; commit ea59b38 |

**Commits**: ea59b38, f1d36ee

### H4: Extract generic useApiQuery factory hook

| Item | Resolution | Source |
|------|-----------|--------|
| H4 | Created `src/hooks/useApiQuery.ts` generic factory with `useQuery<TRaw, Error, T>` three-type-param signature. Applied to 11 hooks, eliminating ~100+ LOC of fetch boilerplate. Two-type-param approach for correct TQ memoization of `select` option. Converted useAgentStats and useTraceEvaluations with custom validation in select branch. | Session aaf11fa follow-up; commits 0c62094, 0d0410a |

**Commits**: 0c62094, 0d0410a

### H5: Adopt PageShell wrapper in CompliancePage

| Item | Resolution | Source |
|------|-----------|--------|
| H5 | CompliancePage migrated from manual loading/error/skeleton handling to PageShell wrapper. Removed 15 LOC of per-section state management. Combines two query states (`slaLoading \|\| verLoading`, `slaError ?? verError`) for unified skeleton/error display. | Session aaf11fa follow-up; commit c539524 |

**Commit**: c539524

## MEDIUM Priority (M3–M8)

### M3: Combine table header selectors in theme.css

| Item | Resolution | Source |
|------|-----------|--------|
| M3 | Merged duplicate `.sla-table th, .eval-table th` selectors from 3 separate rules into shared table header base rule. Consolidated font-size property definition. | Session aaf11fa follow-up; commit 23e30f9 |

**Commit**: 23e30f9

### M4: Extract tooltip base styles to .tooltip-base

| Item | Resolution | Source |
|------|-----------|--------|
| M4 | Added `font-size: var(--font-size-xs)` to shared tooltip popup base rule. Removed from individual `.histogram-bar .tooltip` and `.score-badge-tooltip` rules. | Session aaf11fa follow-up; commit 5bf70ab |

**Commit**: 5bf70ab

### M5: Create TruncatedList component

| Item | Resolution | Source |
|------|-----------|--------|
| M5 | Created `src/components/TruncatedList.tsx` generic component `TruncatedList<T>` for slice+map+more pattern. Applied to 3 instances in SessionDetailPage (errorDetails, hallucinationEvals, failedEvals). Includes JSDoc on `total` prop for server-side pre-truncated data. | Session aaf11fa follow-up; commits be078a3, 550c5cb |

**Commits**: be078a3, 550c5cb

### M6: Move Stat and FreqBar to components/

| Item | Resolution | Source |
|------|-----------|--------|
| M6 | Created `src/components/Stat.tsx` and `src/components/FreqBar.tsx` from inline SessionDetailPage definitions. Extracted BarIndicator usage to FreqBar. Removed unused imports from SessionDetailPage. | Session aaf11fa follow-up; commit 7a22356 |

**Commit**: 7a22356

### M8: Create reusable MetadataRow component

| Item | Resolution | Source |
|------|-----------|--------|
| M8 | Created `src/components/MetadataRow.tsx` with horizontal label-value pattern (nullish-safe). Replaced local `TooltipRow` function in ScoreBadge.tsx with MetadataRow import. Removed 4 conditional guards (MetadataRow returns null when value is nullish). | Session aaf11fa follow-up; commit 34e50d2 |

**Commit**: 34e50d2

## LOW Priority (L1–L6)

### L1: Use space tokens for hardcoded px values

| Item | Resolution | Source |
|------|-----------|--------|
| L1 | Converted hardcoded px values to space tokens: `min-height: var(--space-half)`, `border-left-width: var(--space-1)`, `height: var(--space-1-5)`, `height: var(--space-1)`, `padding: var(--space-2-5)`, `padding: var(--space-3)`. Note: 5px has no token, left hardcoded in cell-pad. | Session aaf11fa follow-up; commit d165340 |

**Commit**: d165340

### L2: Standardize fade-in animation durations

| Item | Resolution | Source |
|------|-----------|--------|
| L2 | Standardized all fade-in animation durations to `var(--transition-fast)`. Changed `0.15s ease-in-out` and `0.2s ease-in-out` inline expressions to token. | Session aaf11fa follow-up; commit d535ad7 |

**Commit**: d535ad7

### L3 + L4: Utility class matrix completion

| Item | Resolution | Source |
|------|-----------|--------|
| L3 | Added `.mono-2xs`, `.mono-base`, `.mono-md`, `.mono-lg`, `.mono-2xl` to complete mono utility matrix. | Session aaf11fa follow-up; commit 1a11f57 |
| L4 | Added `.gap-5` (20px), `.gap-16` (64px), `.mb-4` (16px) gap/margin utilities for full coverage. | Session aaf11fa follow-up; commit 1a11f57 |

**Commit**: 1a11f57

### L5: Consolidate Recharts config duplication

| Item | Resolution | Source |
|------|-----------|--------|
| L5 | Extracted shared Recharts config to `src/lib/constants.ts`: `CHART_MARGIN`, `CHART_GRID_PROPS`, `CHART_AXIS_TICK`, `CHART_TOOLTIP_CONTENT_STYLE`, `CHART_TOOLTIP_LABEL_STYLE`, `CHART_YAXIS_WIDTH`, `CHART_YAXIS_TICK_FORMATTER`. Applied to TrendChart and TrendSeries, eliminating duplication. Hardened `CHART_YAXIS_TICK_FORMATTER` signature. | Session aaf11fa follow-up; commits 2ce5347, 2bbb960, 6fab38d |

**Commits**: 2ce5347, 2bbb960, 6fab38d

### L6: Create TruncatedIdLink component

| Item | Resolution | Source |
|------|-----------|--------|
| L6 | Created `src/components/TruncatedIdLink.tsx` component extracting `Link + truncateId` pattern. Applied to AgentActivityPanel session/trace ID columns (2 instances). Component includes `title={id}` for full-ID hover. Removed now-unused Link import from AgentActivityPanel. | Session aaf11fa follow-up; commit 285a533 |

**Commit**: 285a533

---

## Summary

**Items migrated**: 14 (H1, H4, H5, M3, M4, M5, M6, M8, L1, L2, L3, L4, L5, L6)
**Total commits**: 18 (including follow-up fixes)
**Code review score**: 8/10 (final full-stack review)
**Critical issues**: 0 | **High issues**: 0 (design-level) | **Medium issues**: 0

**Key achievements**:
- DRY consolidation across theme.css, component hooks, and Recharts config
- 5 new reusable components (TruncatedList, Stat, FreqBar, MetadataRow, TruncatedIdLink)
- Generic useApiQuery factory eliminating ~100+ LOC of fetch boilerplate
- Complete space token and utility class coverage in theme.css
- Data-attribute selector pattern for status theming (scalable to future status types)

**Follow-ups recorded**: 8 low-priority items (FR1–FR8) in BACKLOG.md for future sessions
