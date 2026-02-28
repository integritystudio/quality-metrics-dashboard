# Dashboard Backlog

Open items from code reviews and deferred work.

## theme.css DRY — remaining token gaps (2026-02-28)

Source: code-reviewer DRY audit. H1-H3, M1-M12, L1-L5 resolved. Items below are residual.

### Tokenize remaining font-size values
- [x] `font-size: 14px` used 5x (body, metric-card-header h3, alert-message, sla-table, tab-btn) — add `--font-size-base: 14px` ✓
- [x] `font-size: 16px` used 1x (section-heading) — add `--font-size-md: 16px` ✓
- [x] `font-size: 20px` used 1x (header h1) — add `--font-size-lg: 20px` ✓
- [x] `font-size: 24px` used 1x (summary-count .value) — add `--font-size-xl: 24px` ✓
- [x] `font-size: 28px` used 1x (metric-values .primary) — add `--font-size-2xl: 28px` ✓
- [x] `font-size: 9px` used 1x (cot-summary::before triangle) — add `--font-size-2xs: 9px` ✓

### Tokenize remaining raw spacing
- [x] `10px` used in eval-table th/td padding and eval-expanded-panel — added `--space-2-5: 10px` ✓
- [x] `padding: 10px 12px` in score-badge-tooltip — replaced with `var(--space-2-5) var(--space-3)` ✓

### Shadow glow critical alpha
- [x] `--shadow-glow-critical` uses inline `rgba(240,68,56,0.2)` — added `--critical-alpha-20` ✓

### Residual gaps (from 2026-02-28 code review)
- [x] `--shadow-glow-healthy` and `--shadow-glow-warning` — added `--healthy-alpha-15` and `--warning-alpha-15` to complete glow alpha series ✓
