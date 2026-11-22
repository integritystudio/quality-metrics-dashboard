# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-SYNC-90D-PERIOD | Write the `90d` KV entries and lift the header's 90d data gate | P3 | `'90d'` is a full period in code, but the parent's `kv-sync` Workflow caps `maxDays` at 30, so no `:90d` entry exists and `DATA_GATED_PERIOD` hides the button. Split out of DASH-LINT-PARENT-PARITY on 2026-10-21. Source: session 2026-10-18 |
| DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS | The judge sees a turn's oldest tool results, not its newest | Done | Fixed 2026-10-22: `fitContextForJudge` keeps the latest. Found by the judge-suite audit's mutation check. Source: session 2026-10-22 |

**DASH-SYNC-90D-PERIOD.** `DEFAULT_LOOKBACK_90D` is `PERIOD_MS['90d']`: `'90d'` is a full period
(`PERIOD_KEYS`, `VALID_PERIODS`, `PERIOD_MS`, the header selector, shortcut `4`, and `org-kv-entries`,
which iterates `PERIOD_KEYS` instead of its own copy of the list). ⚠️ **The parent's `kv-sync` Workflow caps `maxDays` at 30** (the
deleted `sync-to-kv` defaulted to `--days=30`), and a period longer than the window is skipped, so no
`:90d` KV entry is written. The cap was left alone deliberately: the whole-org build held
~1.65 GB in memory at 30 days, and the evaluation read spans `METRIC_DETAIL_WINDOWS` × the window. The
parity tests' `it.each` period lists do not cover `90d`.
- **So the header hides 90d until it has data.** `DATA_GATED_PERIOD` (`constants.ts`) names it;
  `Layout` asks `useOfferPeriod` — `useDashboard` for that period, which maps the worker's
  `ERR_NO_DATA` 404 to a `no_data` summary — and shows the button, and registers shortcut `4`, once a
  real summary comes back, when the check **fails** (so an outage never hides a period that has data),
  or while 90d is the selected period; it stays hidden only while the first check loads and on a
  no-data answer. `Layout.test.tsx` covers those five states against the real query stack. The gate
  re-checks every `DATA_GATE_POLL_INTERVAL_MS` (an hour, the KV refresh cadence) rather than the
  page's 30 s; react-query polls at the shortest interval among a key's observers, so it drops to
  30 s only while the 90d page itself is open.
- **Memory is the blocker, not the flag.** The CLI holds a whole org in memory per period read, so a
  `--days=90` default needs either the partitioned design in the parent's
  `docs/roadmap/kv-sync-in-worker.md` or a measured run showing 90 days fits; measure before flipping
  the launchd wrapper's arguments.

Acceptance: a scheduled sync writes the `:90d` entries, the `it.each` period lists in the parity tests
cover `90d`, `DATA_GATED_PERIOD` and `useOfferPeriod` are deleted, and e2e asserts all four periods
(today it asserts only the three always-offered ones, since the fourth depends on the environment's data).

**DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS.** `extractTurns` (`judge-turns.ts`) keeps a turn's last
`MAX_TOOL_RESULTS_PER_TURN` (20) tool results. `fitContextForJudge` then keeps the *first*
`MAX_TOOL_CONTEXT_ITEMS` (10) of those, so on a turn with more than 10 the judge never sees the 10 most
recent — usually the ones the reply rests on. Every judge path calls `fitContextForJudge`: per-criterion,
consolidated, the hallucination probe, and the usage estimate. Decide which end is meant, then make the
two agree. The `fitContextForJudge` item-limit test asserts only a length until then.
Acceptance: one end chosen and documented on `fitContextForJudge`, and a test pinning which items survive.
**Done (2026-10-22).** The latest end: `fitContextForJudge` now takes `slice(-itemLimit)`, matching
`extractTurns`, and its doc comment says why. The item-limit test asserts the surviving items are the
newest `MAX_TOOL_CONTEXT_ITEMS`, and it failed on the old `slice(0, itemLimit)`.

### API client

No open items.

### Admin customer view

No open items.

### API keys

No open items.

### Security

No open items.

### Tooling and config

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-UNDICI-OVERRIDE-MAJOR | The `undici` override holds jsdom a major version back | P4 | Pre-existing; surfaced while reviewing the `$undici` repoint. Source: session 2026-10-17 |
| DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE | Audit the seven `scripts/__tests__` judge and sync files for test quality | P3 | The magic-number sweep's review pass touched them twice in one day (`9663020`); the review checked only for semantic drift, never whether each test fails when its implementation is wrong. Source: session 2026-10-19 |

**DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE.** Files: `scripts/__tests__/judge-evaluations.test.ts`,
`pipeline-integration.test.ts`, `derive-evaluations.test.ts`, `sync-prioritization.test.ts`,
`judge-hallucination-eval.test.ts`, `judge-consolidated.test.ts`, `judge-selection.test.ts`. The
magic-number sweep (666 literals named across 74 files, six agents in parallel) and its review fixes
rewrote these seven most heavily, and the read-only review hunted only for assertions that had come to
track their own source constant or lost a boundary; it ran no mutation and did not judge the tests on
their own terms. Audit each file for:
- **Contract, not internals.** Every test exercises the module's public surface and would survive a
  refactor that keeps behaviour; drop or rewrite tests pinned to private helpers or call order.
- **Three paths per behaviour.** Happy path, the boundary (caps, empty input, exact thresholds such as
  `MAX_TEXT_LENGTH`, `MIN_TRACE_BUDGET`, the 19-character turn key) and the error path each have a test
  that fails for the right reason.
- **Real collaborators.** Doubles only at the true boundaries (the LLM provider, the network, process
  exit, the clock); `createMockLLM`/`createFakeProvider` stay, incidental mocks of sibling modules go.
- **Assertions that can fail.** No expected value computed by the code under test, no `toHaveLength`
  of the result's own length, no `toBeCloseTo` where exact equality holds; one behaviour per test,
  Arrange-Act-Assert visible, names that state the behaviour (`'returns 0.5 for in_progress tasks'`
  must still say 0.5 somewhere a reader can check).
- **Fixtures earn their constants.** A hoisted `const` is justified only when a reader needs the name
  to understand the assertion; a `CLOSE_TO_DIGITS` or `OVERFLOW_CHARS` repeated across files belongs in
  `scripts/__tests__/support/`, which the sweep was told not to touch.
Acceptance: a written per-file verdict (keep / rewrite / delete per test), the rewrites landed,
`npm run test:scripts` green, and a mutation spot-check — flip one threshold or comparison in each
module under test and confirm at least one of its tests fails.

**Status (2026-10-22).** The verdict and the spot-check are written in
[`docs/reviews/2026-10-22-judge-suite-test-audit.md`](reviews/2026-10-22-judge-suite-test-audit.md):
32 mutants went from 15 to 25 killed by the seven files, and each survivor is accounted for there.
The rewrites that let a mutant through or could pass for the wrong reason have landed, and
`test:scripts` is green (872). **What remains is the review's _Remaining_ rows:**
- the `it.each` splits and `toBeCloseTo` → `toBe` changes; and
- moving the derive task-completion tests onto `deriveAll`, so the test-only accumulator exports can go.

**DASH-UNDICI-OVERRIDE-MAJOR.** `jsdom@30.1.2` declares `undici: ^8.11.2`, but the root `overrides`
entry forces 7.30.0 onto every copy, so `npm ls undici` shows jsdom's edge as `deduped` to a version
its own range excludes — a major downgrade npm reports as satisfied. Dev- and test-only (jsdom is the
vitest DOM environment and nothing under `src/`, `worker/` or `scripts/` imports `undici` directly; it
is declared only so the override's `$undici` reference resolves), and the suites pass, so this is a
record rather than a defect. Two things follow from it:
- The override exists for a security floor (b21a7be, "compromised undici"), so it should not simply be
  dropped to let jsdom have 8.x. Raising it to `^8` means checking `miniflare`, whose edge is 7.29.1.
- **The `$undici` form couples the override to the devDependency.** Removing the devDependency breaks
  the reference, and bumping it moves every transitive copy with it. That is the point — it is what
  keeps one version in the tree — but it means the devDependency is load-bearing despite being
  imported nowhere. Do not "clean it up" as unused.

### Consolidation

Small duplications found by the 2026-11-21 review of `docs/repomix/repomix.xml`. Each saves a few
hundred tokens at most; none is a defect. Savings are chars/4 estimates.

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-PERMISSION-LITERALS-FOUR-COPIES | Derive the permission and role types from one list | P4 | The same literals are spelled in `types/auth.ts`, `auth-schemas.ts`, `org-rbac.ts` and `e2e/integration/setup.ts`. ~300 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-API-ROUTER-SCAFFOLDING | Share the dev API's router setup and id-param guard | P4 | 13 route files repeat `new Hono()` + `onError`; the id guard is written five times. ~300 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-WORKFLOW-GRAPH-REPEATS | Remove the repeated wrapper and set-building in the workflow views | P4 | `WorkflowGraph` writes its container four times; `AgentWorkflowView` builds five sets for one filter. ~400 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-DATA-TABLE-AND-STAT-TILE | Give plain tables and stat tiles one component each | P4 | Plain `data-table` markup with a hand-written head in six files; the stat tile is hand-written eight times, plus `text-md` variants. ~450 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-JUDGE-CLIENT-OWN-HTTP1-FETCH | Use the parent's `http1Fetch` in `judge-anthropic-client.ts` | P4 | It re-implements what five other scripts import. ~250 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-POPULATE-STAGE-WRAPPERS | Drive `populate-dashboard`'s stages from a table | P4 | Four near-identical `run*` wrappers and four soft-exit sets. ~350 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-JUDGE-RECORD-TWO-BUILDERS | Build the judge record in one place | P4 | `createEvalRecord` and `buildRecord` differ only in `evaluator`. ~200 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-USE-TRACE-OWN-FETCH | Build `useTrace` on `useApiQuery` | P4 | It carries a "must not drift" comment about the hook it duplicates. ~215 tokens. Source: repomix consolidation review, session 2026-11-21 |

**DASH-PERMISSION-LITERALS-FOUR-COPIES.** `DashboardPermission` (`src/types/auth.ts`),
`DashboardPermissionSchema` (`src/lib/validation/auth-schemas.ts`) and `PERMISSION`
(`src/lib/org-rbac.ts`) each list the permissions, and `E2E_PERMISSIONS` in
`e2e/integration/setup.ts` restates the nine that `PERMISSIONS_BY_DASHBOARD_ROLE['e2e-dashboard-reader']`
already holds. `OrgMembershipRole`, `DashboardRole` and `OrgMembershipSummary` in `types/auth.ts`
likewise restate the enums and schema beside them in `auth-schemas.ts`.
- `auth-schemas.ts` and `org-rbac.ts` import types from `types/auth.ts` today, so the direction flips;
  keep the new imports type-only to avoid a cycle.
- `setup.ts` writes its list into the dev database's role, so after the change it writes whatever
  `org-rbac.ts` says.

Acceptance: one list per concept with the types derived by `z.infer` (or from `PERMISSION`), `setup.ts`
importing the role's permissions, and typecheck green.

**DASH-API-ROUTER-SCAFFOLDING.** Every file under `src/api/routes/` opens with
`export const xRoutes = new Hono(); xRoutes.onError(handleRouteError);`, and `src/api/server.ts`
imports and mounts each one by hand. The four-line id guard (`isValidParam(id, ID_PATTERN)` then a 400)
appears in `traces.ts`, `evaluations.ts`, `sessions.ts` and twice in `agents.ts`; the Worker already has
the middleware form (`requireParam` in `worker/app-context.ts`).
- A full route table is not worth it: `metrics.ts` and `trends.ts` use `resolveMetric` and a
  `now`-anchored window, three routes read spans, and `/dashboard` branches on `role`.
- The route tests mount the individual `xRoutes` exports, so those stay.

Acceptance: a `createRouter()`, one loop in `server.ts`, and one runtime-neutral id middleware beside
`query-validator.ts` used by both the dev routes and the Worker.

**DASH-WORKFLOW-GRAPH-REPEATS.** In `src/components/WorkflowGraph.tsx` the
`<div ref={containerRef} className="workflow-graph-container" …>` wrapper is written at each of the four
return sites; the agent and cluster nodes repeat `role`/`tabIndex`/`onKeyDown` and the error badge with
its two `Handle`s; `buildNodeDataMap` is `new Map(nodes.map(n => [n.id, n]))` with two callers. A set
toggle is hand-rolled in both `WorkflowGraph.tsx` and `AgentWorkflowView.tsx`, and `filteredNodeIds` in
`AgentWorkflowView.tsx` builds five intermediate sets where one `.filter` with three predicates gives
the same result. `isWorkflowNode` and `isClusterNodeData` were judged not worth replacing in the
2026-10-12 library audit; leave them.

Acceptance: the wrapper rendered once, a `toggleInSet` in `src/lib/collections.ts`, and
`WorkflowGraph.test.tsx` and `WorkflowTimeline.test.tsx` green without edits.

**DASH-DATA-TABLE-AND-STAT-TILE.** Plain `<table className="data-table">` with a hand-written
`<thead>` appears in `DegradationSignalsPage.tsx`, `RoutingTelemetryPage.tsx`,
`AgentCodeQualityPage.tsx`, `SLATable.tsx`, `CompliancePage.tsx` and `ComplianceFrameworkMap.tsx`; the
two TanStack heads in `AgentActivityPanel.tsx` and `EvaluationTable.tsx` are the same loop. The stat
tile (`text-center` > `mono-xl font-semibold` value > `text-secondary text-xs uppercase` label) is
written twice in `App.tsx` and six times in `RoutingTelemetryPage.tsx`, with `text-md` variants in
`MetricCompare.tsx`, `SessionDetailPage.tsx` and `AgentSessionPage.tsx`.
- Start with the cheap step: let `MonoTableHead` take a plain variant. A column-driven `DataTable<T>`
  can cost more than it saves on the two-column tables.
- `StatDisplay`'s existing `.summary-count .value` is 2xl/bold, so the tile needs its own variant or
  the look changes. The sr-only tables in `CQIHero.tsx` and `PipelineFunnel.tsx` stay as they are.

Acceptance: one head component for the plain tables, a `variant="tile"` on `StatDisplay` used at the
exact-match sites, and no visual change at 1280 px.

**DASH-JUDGE-CLIENT-OWN-HTTP1-FETCH.** `scripts/judge-anthropic-client.ts` builds its own HTTP/1.1
`fetch` from a dynamically imported `undici`. The parent's `src/lib/core/http1-fetch.ts` is the same
thing, and `cloud-trace-source.ts`, `kv-client.ts`, `evaluation-delivery.ts` and
`backtest-degradation.ts` already import it.
- The local copy resolves this app's undici 7; the parent's resolves undici 8. The cast and its comment
  exist for that type gap, so check the parent's `fetch` against the Anthropic SDK's
  `ClientOptions['fetch']` before swapping.
- Keep the SDK's own dynamic import: it is what keeps `--dry-run` from loading the SDK.

Acceptance: the parent's `http1Fetch` passed to the SDK client, the local builder and cast gone, and a
real (non-dry-run) judge call succeeding.

**DASH-POPULATE-STAGE-WRAPPERS.** `runDerive`, `runHookGapCheck`, `runShipTurns` and `runJudge` in
`scripts/populate-dashboard.ts` each build arguments, call `runStep` or `runWithNetworkRetry`, and hand
the outcome to `continueOrAbort` with a message that differs only in the stage name; each script name
is spelled three times per wrapper. `scripts/pipeline-stages.ts` holds one `*_SOFT_FAILURE_EXITS` set
per stage plus the `nextStepAfter` switch over them.
- Log wording changes unless the message is templated from the table.
- Tests import `JUDGE_SOFT_FAILURE_EXITS` and `DERIVE_SOFT_FAILURE_EXITS` by name.

Acceptance: one `runStage` driven by a stage table, one `Record<PipelineStage, ReadonlySet<number>>`
replacing the four sets and the switch, and `pipeline-stages.test.ts` green.

**DASH-JUDGE-RECORD-TWO-BUILDERS.** `createEvalRecord` (`scripts/judge-evaluations.ts`) and
`buildRecord` (`scripts/judge-consolidated.ts`) emit the same fields in the same order; only
`evaluator` differs (`PRODUCER` against `CONSOLIDATED_PRODUCER`). `createEvalRecord`'s `kind`, `cohort`
and optional `judgeModel` have one call site, which always passes LLM / normal / Haiku. The batched
entry points (`evaluateTurnsBatched`, `evaluateTurnsConsolidatedBatched`) share their
map / flush / all / throw-on-failure body as well.
- ⚠️ Field order is part of a record's identity when it has no `stableEvaluationKey`
  (`eval-record.ts`), so the merged builder must keep it. Judge records do carry the key.

Acceptance: one `judgeRecord(turn, producer, judgeModel, scored)` beside `turnSourceFields`, and a test
showing both paths' records are byte-identical to today's apart from `evaluator`.

**DASH-USE-TRACE-OWN-FETCH.** `src/hooks/useTrace.ts` calls `useQuery` directly and re-implements the
fetch, 404 handling and retry policy of `src/hooks/useApiQuery.ts`.
- With `useApiQuery`, a non-404 error message gains the response body (`API error: 500 – <body>`),
  which `PageShell` displays.
- `query-abort.test.tsx` imports this hook.

Acceptance: `useTrace` as a `useApiQuery` call with `onNotFound` returning the empty trace, the
"must not drift" comment gone, and `query-abort.test.tsx` green.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
