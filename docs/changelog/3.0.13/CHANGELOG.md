# 3.0.13 Changelog

Released 2026-11-21

> 11 completed items migrated from `BACKLOG.md`. Each row is the entry's own backlog text, copied verbatim.

## Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS | The judge sees a turn's oldest tool results, not its newest | Done | Fixed 2026-10-22: `fitContextForJudge` keeps the latest. Found by the judge-suite audit's mutation check. Source: session 2026-10-22 |

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

## Tooling and config

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-UNDICI-OVERRIDE-MAJOR | The `undici` override holds jsdom a major version back | Done | Pre-existing; surfaced while reviewing the `$undici` repoint. Source: session 2026-10-17 |
| DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE | Audit the seven `scripts/__tests__` judge and sync files for test quality | Done | The magic-number sweep's review pass touched them twice in one day (`9663020`); the review checked only for semantic drift, never whether each test fails when its implementation is wrong. Source: session 2026-10-19 |

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

**Done (2026-11-21).** A scoped override, `"jsdom": { "undici": "^8.13.1" }`, gives jsdom its own
8.x copy (`node_modules/jsdom/node_modules/undici`) while the root `$undici` floor keeps the root and
miniflare on 7.30.1. miniflare pins `7.29.1` exactly, so it was left on 7.x rather than forced onto a
major it does not declare. `npm audit` lists no undici advisory; `npm test` (1296) and `typecheck` are
green. Widen the floor to `^8` only once miniflare declares 8.x.

**DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE.** Files: `scripts/__tests__/judge-evaluations.test.ts`,
`pipeline-integration.test.ts`, `derive-evaluations.test.ts`, `judge-hallucination-eval.test.ts`,
`judge-consolidated.test.ts`, `judge-selection.test.ts`, and `sync-prioritization.test.ts`, deleted
with `sync-to-kv.ts` in `3a2c319`, so six remain. The
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

**Done (2026-11-21).** Both landed: every Remaining row in the review is now Landed, the derive
task-completion tests run through `deriveAll`, and the five test-only exports are gone.
`test:scripts` is green (823). The one leftover is the 10-digit `toBeCloseTo` precision constant,
now copied in four `scripts/__tests__` files, which belongs in `support/`.

## Consolidation

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-PERMISSION-LITERALS-FOUR-COPIES | Derive the permission and role types from one list | Done | The same literals are spelled in `types/auth.ts`, `auth-schemas.ts`, `org-rbac.ts` and `e2e/integration/setup.ts`. ~300 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-API-ROUTER-SCAFFOLDING | Share the dev API's router setup and id-param guard | Done | 13 route files repeat `new Hono()` + `onError`; the id guard is written five times. ~300 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-WORKFLOW-GRAPH-REPEATS | Remove the repeated wrapper and set-building in the workflow views | Done | `WorkflowGraph` writes its container four times; `AgentWorkflowView` builds five sets for one filter. ~400 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-DATA-TABLE-AND-STAT-TILE | Give plain tables and stat tiles one component each | Done | Plain `data-table` markup with a hand-written head in six files; the stat tile is hand-written eight times, plus `text-md` variants. ~450 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-JUDGE-CLIENT-OWN-HTTP1-FETCH | Use the parent's `http1Fetch` in `judge-anthropic-client.ts` | Done | It re-implements what five other scripts import. ~250 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-POPULATE-STAGE-WRAPPERS | Drive `populate-dashboard`'s stages from a table | Done | Four near-identical `run*` wrappers and four soft-exit sets. ~350 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-JUDGE-RECORD-TWO-BUILDERS | Build the judge record in one place | Done | `createEvalRecord` and `buildRecord` differ only in `evaluator`. ~200 tokens. Source: repomix consolidation review, session 2026-11-21 |
| DASH-USE-TRACE-OWN-FETCH | Build `useTrace` on `useApiQuery` | Done | It carries a "must not drift" comment about the hook it duplicates. ~215 tokens. Source: repomix consolidation review, session 2026-11-21 |

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
**Done (2026-11-21).** `PERMISSION` (`org-rbac.ts`) is the one permission list and
`DashboardPermissionSchema` is `z.enum(PERMISSION)`; `DashboardPermission`, `OrgMembershipRole`,
`DashboardRole` and `OrgMembershipSummary` are `z.infer` of the schemas, imported type-only.
`OrgMembershipRoleValue` is gone in favour of `OrgMembershipRole`. `setup.ts` takes the role's
permissions from `PERMISSIONS_BY_DASHBOARD_ROLE`.

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
**Done (2026-11-21).** `createRouter()` and `requireId()` live in `src/api/route-errors.ts`;
`server.ts` mounts a `ROUTERS` list in one loop. `requireParam` moved from `worker/app-context.ts` to
`src/lib/query-validator.ts`, generic over the Hono env, and both runtimes use it. On
`/sessions/:sessionId` the dev server now checks the id before the query, as the Worker does.

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
**Done (2026-11-21).** `WorkflowGraphView` renders the container once around a `renderGraphBody()`;
`NodeShell` holds the shared node semantics, error badge and handles; `buildNodeDataMap` is inlined;
`toggleInSet` (`src/lib/collections.ts`) serves both toggles; `filteredNodeIds` is one `.filter`. Both
test files pass unedited.

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
**Done (2026-11-21).** `MonoTableHead` takes `variant="plain"`: bare `<th>` cells, aligned only when a
column asks, under the table's own `.data-table th` styles. All eight plain heads in the six files use it.
`StatDisplay` takes `variant="tile"`, which `App.tsx` (2) and `RoutingTelemetryPage.tsx` (6) use; its classes
sit in one per-variant table. Rendered markup was compared with the old hand-written markup and is
identical for both new variants and unchanged for `mono` and `inline`, so there is no visual change. Not
converted: the two TanStack heads (sortable cells with per-column classes, not plain tables) and the
`text-md` tiles in `MetricCompare.tsx`, `SessionDetailPage.tsx` and `AgentSessionPage.tsx`, which are not
exact matches.

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
**Done (2026-11-21).** The client passes the parent's `http1Fetch`; it typechecks against
`ClientOptions['fetch']` with no cast. The unit test still sees HTTP/1.1 ALPN, and a real Haiku call
through `createJudgeAnthropicClient` returned `end_turn`.

**DASH-POPULATE-STAGE-WRAPPERS.** `runDerive`, `runHookGapCheck`, `runShipTurns` and `runJudge` in
`scripts/populate-dashboard.ts` each build arguments, call `runStep` or `runWithNetworkRetry`, and hand
the outcome to `continueOrAbort` with a message that differs only in the stage name; each script name
is spelled three times per wrapper. `scripts/pipeline-stages.ts` holds one `*_SOFT_FAILURE_EXITS` set
per stage plus the `nextStepAfter` switch over them.
- Log wording changes unless the message is templated from the table.
- Tests import `JUDGE_SOFT_FAILURE_EXITS` and `DERIVE_SOFT_FAILURE_EXITS` by name.

Acceptance: one `runStage` driven by a stage table, one `Record<PipelineStage, ReadonlySet<number>>`
replacing the four sets and the switch, and `pipeline-stages.test.ts` green.
**Done (2026-11-21).** `populate-dashboard.ts` runs a `STAGES` table (stage, script, whether it runs,
args, network retry, log continuation) through one `runStage`; the four wrappers and `continueOrAbort`
are gone and the log wording is unchanged. `SOFT_FAILURE_EXITS` in `pipeline-stages.ts` is the one
`Record<PipelineStage, ReadonlySet<number>>`, and `nextStepAfter` is a lookup into it. The tests read
`SOFT_FAILURE_EXITS.judge` / `.derive`, and `nextStepAfter` now also covers the hook-gap and ship-turns
stages. `test:scripts` is green (834).

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
**Done (2026-11-21).** `judgeRecord` and `ScoredCriterion` live in `judge-turns.ts` beside
`turnSourceFields`; `createEvalRecord` (with its unused `kind`/`cohort`/optional `judgeModel`) and
`buildRecord` are gone. The batched entry points share `settleBatchedTurns` (`judge-batch-provider.ts`).
Before the change, 12 records from both old builders (both producers, span / response-id / unanchored
turns) were captured; `judgeRecord` reproduces them byte for byte. `judge-record.test.ts` pins that JSON text,
and swapping two fields fails all four tests. `judge-turns.ts` now imports `judge-dedup.ts` and
`qfe-label-ordinals.ts`; both already loaded under workerd, and the parent's
`dashboard-pipeline-loads.workers.test.ts` passes. `test:scripts` is green (839).

**DASH-USE-TRACE-OWN-FETCH.** `src/hooks/useTrace.ts` calls `useQuery` directly and re-implements the
fetch, 404 handling and retry policy of `src/hooks/useApiQuery.ts`.
- With `useApiQuery`, a non-404 error message gains the response body (`API error: 500 – <body>`),
  which `PageShell` displays.
- `query-abort.test.tsx` imports this hook.

Acceptance: `useTrace` as a `useApiQuery` call with `onNotFound` returning the empty trace, the
"must not drift" comment gone, and `query-abort.test.tsx` green.
**Done (2026-11-21).** `useTrace` is a `useApiQuery` call whose `onNotFound` returns the empty
trace, and it now takes `useApiQuery`'s retry policy: the same two retries, but none after an auth
failure or a 401. `QUERY_RETRY_COUNT` had no other user and is gone. A non-404 error now carries the
response body. `useTrace.test.tsx` pins the encoded URL, the 404-as-empty path, the error message and
the disabled state; `query-abort.test.tsx` passes unedited.
