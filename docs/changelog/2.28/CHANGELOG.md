# v2.28 — DRY Refactor Completion

**Date**: 2026-02-28

## Theme CSS Token Completion

### Tokenize remaining font-size values

| Item | Resolution | Source |
|------|-----------|--------|
| H1.1 | `--font-size-base: 14px` — 5 uses (body, metric-card-header h3, alert-message, sla-table, tab-btn) | Migrated from BACKLOG.md |
| H1.2 | `--font-size-md: 16px` — 1 use (section-heading) | Migrated from BACKLOG.md |
| H1.3 | `--font-size-lg: 20px` — 1 use (header h1) | Migrated from BACKLOG.md |
| H1.4 | `--font-size-xl: 24px` — 1 use (summary-count .value) | Migrated from BACKLOG.md |
| H1.5 | `--font-size-2xl: 28px` — 1 use (metric-values .primary) | Migrated from BACKLOG.md |
| H1.6 | `--font-size-2xs: 9px` — 1 use (cot-summary::before triangle) | Migrated from BACKLOG.md |

**Commits**: 70a788a

### Tokenize remaining raw spacing

| Item | Resolution | Source |
|------|-----------|--------|
| H2.1 | `--space-2-5: 10px` — eval-table th/td padding, eval-expanded-panel | Migrated from BACKLOG.md |
| H2.2 | `padding: 10px 12px` → `var(--space-2-5) var(--space-3)` in score-badge-tooltip | Migrated from BACKLOG.md |

**Commit**: 181a084

### Shadow glow critical alpha

| Item | Resolution | Source |
|------|-----------|--------|
| H3.1 | `--critical-alpha-20` token for `--shadow-glow-critical` rgba(240,68,56,0.2) | Migrated from BACKLOG.md |

**Commit**: dd0c67c

### Residual gaps — glow alpha series

| Item | Resolution | Source |
|------|-----------|--------|
| H4.1 | `--healthy-alpha-15` and `--warning-alpha-15` to complete glow alpha token series | Migrated from BACKLOG.md |

**Commit**: 8a4a46b

### DRY theme.css — tokens, shared rules, selector consolidation

| Item | Resolution | Source |
|------|-----------|--------|
| T1 | Add `--space-16`, `--radius-xs`, `--radius-bar` tokens; replace all raw 64px/3px/2px/8px values | Code review |
| T2 | Extract shared rules: `.section-divider`, `.ghost-btn`, `.table-header-base`, `.muted-label`, `.accent-link-hover` | Code review |
| T3 | Consolidate comma selectors: provenance/confidence panels, provenance/agreement grids, eval table hover+expanded, alert meta+remediation | Code review |
| T4 | Remove `.agreement-summary` standalone rule (covered by shared section divider) | Code review |
| T5 | Remove duplicate `.confidence-panel` font-size (merged into `.provenance-panel` comma rule) | Code review |

**Commit**: e882d30

---

## DRY pages/ Refactor

### Extract PageShell component (H1)

| Item | Resolution | Source |
|------|-----------|--------|
| H1 | Extract `PageShell` component (loading/error/back-link) — applied to 7 pages, eliminates ~13 duplicate back-link occurrences | Code review |

### Centralize API_BASE (H2)

| Item | Resolution | Source |
|------|-----------|--------|
| H2 | Centralize `API_BASE` in `src/lib/api.ts` — remove 12 local `const API_BASE` definitions across all hooks | Code review |

### Replace scoreColor with shared utility (H3)

| Item | Resolution | Source |
|------|-----------|--------|
| H3 | Replace local `scoreColor` with `scoreColorBand`/`SCORE_COLORS` from `quality-utils` — removes inconsistent local thresholds | Code review |

**Commits**: 7084538, af44e0e (CQIHero SCORE_COLORS shadow removal)

### Medium priority items (M4–M7)

| Item | Resolution | Source |
|------|-----------|--------|
| M4 | Add `.id-chip` CSS class; apply to ID spans in 3 pages | Code review |
| M5 | Extract `SyncEmptyState` component; apply to TraceDetailPage + EvaluationDetailPage | Code review |
| M6 | Move `fmtBytes`/`shortPath` formatters to `src/lib/quality-utils.ts` | Code review |
| M7 | Move `evalToRow` adapter to `EvaluationTable.tsx` (co-located with `EvalRow` type) | Code review |

**Commits**: 7084538, bb7f141 (SyncEmptyState magic numbers replaced with CSS tokens)

### Low priority items (L8–L10)

| Item | Resolution | Source |
|------|-----------|--------|
| L8 | Add `.page-heading` CSS class; replace `style={{ fontSize: 18 }}` on all h2 page headings | Code review |
| L9 | Add `.card--empty` CSS modifier; apply to 3 empty cards in CompliancePage | Code review |
| L10 | Add `LLM_SAMPLE_RATE` to `src/lib/constants.ts`; import in PipelinePage | Code review |

**Commits**: 7084538, bb7f141 (`--font-size-page-heading` token), af44e0e (remaining h2 in App.tsx)

### Review fixes

| Item | Resolution | Source |
|------|-----------|--------|
| R1 | Add `useMetricDetail.ts` to API_BASE centralization (missed in H2) | Code review — medium finding |
| R2 | Replace `window.location.search` with `useSearch()` from wouter in EvaluationDetailPage | Code review — high finding |
| R3 | Remove duplicate section comment in `quality-utils.ts` | Code review — high finding |

**Commits**: bb7f141, af44e0e

---

## Summary

All DRY refactoring items completed across theme.css and pages/:
- 8 font-size variants (9px–28px), full spacing tokens, complete glow alpha series
- `--space-16`, `--radius-xs`, `--radius-bar` tokens; 5 shared CSS rules; selector consolidation
- `PageShell` component eliminates ~13 duplicate back-link blocks across 7 pages
- `API_BASE` centralized from 12 local definitions to single `src/lib/api.ts` export
- 3 new shared components (`PageShell`, `SyncEmptyState`, `EvaluationTable` adapter)
- 3 new CSS classes (`.id-chip`, `.page-heading`, `.card--empty`)
- `LLM_SAMPLE_RATE` and `scoreColorBand` moved to shared modules
