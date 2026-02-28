# v2.28 — Theme CSS DRY Completion

**Date**: 2026-02-28

## Completed Backlog Items

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

## Summary

All theme.css DRY refactoring items completed. CSS now uses consistent token values for:
- 8 font-size variants (from 9px to 28px)
- Full spacing token coverage (2-5, standard increments)
- Complete glow alpha series (healthy, warning, critical)
