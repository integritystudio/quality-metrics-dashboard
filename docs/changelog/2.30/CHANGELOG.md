# v2.30 — Final Review Follow-ups (FR1–FR8)

**Date**: 2026-03-01

## Overview

Eight low-priority code review findings (FR1–FR8) addressing style consolidation, accessibility, documentation, and component clarity. All items focused on codebase quality and maintainability without feature changes.

## LOW Priority (FR1–FR8)

### FR1: Remove redundant `COLORS` alias in TrendChart

| Item | Resolution | Source |
|------|-----------|--------|
| FR1 | `TrendChart.tsx` contained a local `COLORS` alias object that spread `CHART_COLORS` and added `projection: CHART_COLORS.line`. Since `projection` equalled `CHART_COLORS.line`, the alias was unnecessary. Removed the spread and referenced `CHART_COLORS` directly throughout the component (8 replacements across warning/critical/line/projection/text styles). | Commit 1424c9d |

**Commit**: 1424c9d

### FR2: Document `buildUrl`/`enabled` contract in useApiQuery

| Item | Resolution | Source |
|------|-----------|--------|
| FR2 | `useApiQuery.ts` hook has an implicit coupling: `buildUrl` is invoked inside `queryFn`, which React Query skips when `enabled=false`. Callers using non-null assertion (e.g. `buildUrl: () => \`/api/traces/${traceId!}\``) must also pass `enabled: !!traceId` to prevent execution before the value is available. Added JSDoc explaining the contract and example mitigation pattern. | Commit d3c8d16 |

**Commit**: d3c8d16

### FR3: Move magic number styles from Stat.tsx to theme.css

| Item | Resolution | Source |
|------|-----------|--------|
| FR3 | `Stat.tsx` contained eight inline magic number styles (`fontSize: 22`, `minWidth: 80`, `lineHeight: 1.1`, `letterSpacing: '0.1em'`, `marginTop: 3`). Created three new CSS classes in `theme.css`: `.stat-item` (flex + min-width), `.stat-value` (font-size + line-height), `.stat-label` (letter-spacing + margin-top). Added corresponding CSS custom property tokens (`--font-size-stat: 22px`, `--stat-label-letter-spacing: 0.1em`). Only the dynamic `color` prop remains inline in the component. | Commits 371f663, a45936c |

**Commits**: 371f663, a45936c

### FR4: Add JSDoc note to TruncatedList `renderItem` parameter

| Item | Resolution | Source |
|------|-----------|--------|
| FR4 | `TruncatedList` component calls `renderItem` inside `.map()` without adding a `key` attribute, so the returned element must provide its own `key` prop. This was not documented, leading to potential React warnings. Added JSDoc block to the `renderItem` parameter explaining the requirement and the reason (direct map without wrapping). | Commit 443996b |

**Commit**: 443996b

### FR5: Add `role="img"` to aria-label container in TrendChart

| Item | Resolution | Source |
|------|-----------|--------|
| FR5 | `TrendChart.tsx` had `aria-label` on a plain `<div>` without an explicit ARIA role. Assistive technologies require a role for `aria-label` to be exposed. Added `role="img"` to the container wrapping the Recharts `ResponsiveContainer`. This follows the same pattern as `TrendSeries` and is the correct ARIA pattern for non-interactive chart visualizations. | Commit 5554948 |

**Commit**: 5554948

### FR6: Replace hardcoded column widths in FreqBar with CSS grid

| Item | Resolution | Source |
|------|-----------|--------|
| FR6 | `FreqBar.tsx` used hardcoded inline widths (`width: 160` for label, `width: 36` for count) and `flex: 1` on the bar track. Replaced the flex row layout with a CSS grid (`.freq-bar-row`: `grid-template-columns: 160px 1fr 36px`) in `theme.css`. Removed inline `style` props and `flex`/`shrink-0` utility classes from the component. Layout behaviour is identical but now centralized and declarative. | Commit d66fac9 |

**Commit**: d66fac9

### FR7: Tighten null/empty-string guard in MetadataRow

| Item | Resolution | Source |
|------|-----------|--------|
| FR7 | `MetadataRow.tsx` suppressed rendering when `value == null`, but allowed empty string (`""`) to render a blank row. Tightened the guard to `value == null \|\| value === ''` to suppress both nullish and empty-string values uniformly. Updated JSDoc to reflect the new behaviour. | Commits 76d7e4b, a45936c |

**Commits**: 76d7e4b, a45936c

### FR8: Replace hardcoded bg hex with token and add `role="img"` in TrendSeries

| Item | Resolution | Source |
|------|-----------|--------|
| FR8 | `TrendSeries.tsx` contained hardcoded background hex `#0d1117` (page background color) used as an SVG Area fill mask for the p10 band. Replaced with the resolved hex literal `#131920` (value of `--bg-card` token) and added an inline comment explaining why a hex literal (rather than CSS custom property) is required for SVG `fill` attributes. Also added `role="img"` to the outer `<div>` with `aria-label` for accessibility parity with `TrendChart` (FR5 follow-up). | Commits c2ab8a6, 604e236 |

**Commits**: c2ab8a6, 604e236

## Follow-up Code Review Fixes

### M1: CSS Magic Numbers in Stat Classes

Added two new CSS custom property tokens to `:root` to eliminate raw literals in the new `.stat-value` and `.stat-label` classes:
- `--font-size-stat: 22px` (referenced in `.stat-value`)
- `--stat-label-letter-spacing: 0.1em` (referenced in `.stat-label`)

Changed `.stat-label` to use `var(--space-half)` for `margin-top` (2px closest match) instead of hardcoded `3px`.

**Commit**: a45936c

### M2: Inline Padding Magic in TrendChart

Replaced hardcoded `padding: '8px 0'` in TrendChart dynamics panel with `padding: 'var(--space-2) 0'` (where `--space-2 = 8px`).

**Commit**: a45936c

### L1: Refactor TrendSeries COLORS Spread

Renamed the local `COLORS` object to `TREND_COLORS` and removed the `CHART_COLORS` spread. Now only `TREND_COLORS` contains locally-defined entries (`band`, `bandStroke`, `background`), while `CHART_COLORS.line`, `CHART_COLORS.text`, and `CHART_COLORS.grid` are referenced directly. This clarifies that the latter are shared across chart components.

**Commit**: a45936c

### L2: Update MetadataRow JSDoc

Updated the component JSDoc from "Renders nothing when value is nullish" to "Renders nothing when value is nullish or an empty string" to match the FR7 fix.

**Commit**: a45936c

## Summary

**Total commits**: 10
**Files modified**: 8 (TrendChart.tsx, useApiQuery.ts, Stat.tsx, TruncatedList.tsx, FreqBar.tsx, MetadataRow.tsx, TrendSeries.tsx, theme.css)
**Tests**: All 293 tests pass
**Type safety**: tsc --noEmit clean

No breaking changes. All updates are internal refactorings focused on code clarity, accessibility, and maintainability.
