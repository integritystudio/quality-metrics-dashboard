# Dashboard Backlog

Open items from code reviews and deferred work.

**Resolved items**: [v2.30 Final Review Follow-ups FR1–FR8](changelog/2.30/CHANGELOG.md) (2026-03-01) | [v2.29 DRY Backlog H1–L6](changelog/2.29/CHANGELOG.md) (2026-03-01) | [v2.28 Theme CSS DRY](changelog/2.28/CHANGELOG.md) (2026-02-28) | [DRY pages/ refactor](changelog/2.28/CHANGELOG.md) (2026-02-28)

> All 10 DRY review items (H1–H3, M4–M7, L8–L10) were implemented and committed 2026-02-28.
> See commits 7084538 and bb7f141.

> All 14 DRY backlog items (H1, H4, H5, M3–M6, M8, L1–L6) were implemented 2026-03-01 and migrated to [v2.29 changelog](changelog/2.29/CHANGELOG.md).
> Session aaf11fa follow-up; commits ea59b38–285a533.

## Open Items

### Medium Priority

- **M1**: Inline styles that have existing CSS utilities — `AuditorView.tsx` uses `style={{ marginBottom: 'var(--space-6)' }}` instead of `mb-6`; multiple `padding: '8px 12px'` / `'4px 8px'` could use `p-2` / `p-1-5`; `AgentActivityPanel.tsx` inline `display: 'grid'` could be utility
- **M2**: Inconsistent empty states — `PipelineFunnel.tsx` uses raw `<p>` instead of `<EmptyState>`; `CompliancePage.tsx` uses `card card--empty` instead of `<EmptyState>`; 6 other files correctly use `<EmptyState>` component
- **M3**: Alert-like list rendering duplicated in views — `OperatorView.tsx:25-37` (degrading trends) and `ExecutiveView.tsx:27-37` (top issues) both manually build `<ul className="alert-list">` with identical structure; `AlertList` component exists but handles a different data shape
- **M4**: URL construction for trace/session links — `/evaluations/trace/${traceId}`, `/sessions/${sid}`, `/traces/${tid}` patterns hardcoded in 4+ files; could extract `getTraceHref()`, `getSessionHref()` route helpers

### Low Priority

- **L1**: Percentage formatting inconsistency — `.toFixed(0)%` vs `.toFixed(1)%` across CQIHero, Indicators, MetricCard with no shared `formatPercent()` helper
- **L2**: `FreqBarGrid` private helper in `SessionDetailPage.tsx` — candidate for extraction to `src/components/FreqBarGrid.tsx` if reused elsewhere
- **L3**: Timestamp + tooltip pattern — `title={new Date(ts).toLocaleString()}` repeated in `CompliancePage.tsx` and `EvaluationDetailPage.tsx`; could be a `<TimestampCell>` component
