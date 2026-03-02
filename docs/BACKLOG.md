# Dashboard Backlog

Open items from code reviews and deferred work.

**Resolved items**: [v2.28 Theme CSS DRY Completion](changelog/2.28/CHANGELOG.md) (2026-02-28) | [DRY pages/ refactor](changelog/2.28/CHANGELOG.md) (2026-02-28)

> All 10 DRY review items (H1–H3, M4–M7, L8–L10) were implemented and committed 2026-02-28.
> See commits 7084538 and bb7f141.

## HIGH Priority (H1, H4, H5)

#### H1: Consolidate status color mapping with data-attribute selectors
**Priority**: P1 | **Source**: session:aaf11fa (DRY analysis)
Status-based theming (healthy/warning/critical) repeated 5+ times across `.health-banner.*`, `.status-badge.*`, `.alert-item.*` in theme.css (lines 239-262, 323-324). Replace with single `[data-status="healthy"]` selector pattern. -- `src/theme.css:239-324`

#### H4: Extract generic useApiQuery factory hook
**Priority**: P1 | **Source**: session:aaf11fa (DRY analysis)
Identical `fetch` + `res.ok` check + `staleTime` + `retry` boilerplate in 10+ custom hooks. Extract to `useApiQuery<T>(key, endpoint, params)` factory. Saves ~100+ LOC. -- `src/hooks/*.ts`

#### H5: Adopt PageShell wrapper in CompliancePage
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
CompliancePage manually handles loading/error/skeleton (8 lines). All 8 other pages use `PageShell` consistently. Wrap CompliancePage to remove ~15 LOC. -- `src/pages/CompliancePage.tsx:18,40`

## MEDIUM Priority (M3–M8)

#### M3: Combine table header selectors in theme.css
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
`.sla-table th, .eval-table th` appears in 3 separate rules (lines 140, 332-338, 341-346). Consolidate. -- `src/theme.css:140,332-346`

#### M4: Extract tooltip base styles to .tooltip-base
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
`.histogram-bar .tooltip` and `.score-badge-tooltip` share elevated-surface + absolute-center pattern (lines 378-401, 636-645). Extract shared subset. -- `src/theme.css:378-645`

#### M5: Create TruncatedList component for slice + map + "+N more"
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
Pattern repeated 3x in SessionDetailPage (lines 292-336). Extract `<TruncatedList items max renderItem />`. -- `src/pages/SessionDetailPage.tsx:292-336`

#### M6: Move Stat and FreqBar to components/
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
`Stat()` (lines 22-33) and `FreqBar()` (lines 37-56) defined inline in SessionDetailPage but represent generic patterns. Move to reusable components. -- `src/pages/SessionDetailPage.tsx:22-56`

#### M8: Create reusable LabelValuePair or MetadataRow component
**Priority**: P2 | **Source**: session:aaf11fa (DRY analysis)
MetaItem exists but 4 components render similar label-value pairs with different styling. Standardize with flexible `<MetadataRow />`. -- `src/components/{MetaItem,ScoreBadge,ProvenancePanel,AgentActivityPanel}.tsx`

## LOW Priority (L1–L6)

#### L1: Use or define space tokens for hardcoded px values
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
theme.css lines 371, 740, 847, 899, 975–976: hardcoded `2px`, `4px`, `6px`, `5px 10px` should use space tokens. -- `src/theme.css:371,740,847,899,975-976`

#### L2: Standardize fade-in animation durations
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
fade-in animation used 3x with different durations (0.15s, 0.2s, var(--transition-fast)). Create animation duration variables. -- `src/theme.css:442,618,645`

#### L3: Complete mono utility class matrix
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
theme.css `.mono-xs`, `.mono-xl` exist but no `.mono-base`, `.mono-lg`. Complete the matrix. -- `src/theme.css:873-884`

#### L4: Fill gap/margin utility coverage gaps
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
No `.gap-5`, `.gap-16`. `.mt-*` goes to 4 but `.mb-*` stops at 3. Inconsistent coverage. -- `src/theme.css:902-923`

#### L5: Consolidate Recharts config duplication
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
TrendChart, TrendSeries, MetricCompare have near-identical Recharts `<ResponsiveContainer>` + margin + grid + tooltip. Extract base chart wrapper. -- `src/components/{TrendChart,TrendSeries,MetricCompare}.tsx`

#### L6: Create TruncatedIdLink component
**Priority**: P3 | **Source**: session:aaf11fa (DRY analysis)
`<Link href={/path/${id}}>truncateId(id)</Link>` pattern in 3 files. Extract to `<IdLink />`. -- `src/components/{AgentActivityPanel,ProvenancePanel,EvaluationExpandedRow}.tsx`
