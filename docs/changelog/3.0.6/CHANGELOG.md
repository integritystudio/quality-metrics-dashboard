# v3.0.6 (2026-07-13)

Backlog clearance: library dependency optimizations, type safety improvements, worker API validation hardening, auth consolidation, workflow visualization filters and latency display, degradation signal detection, admin concurrent mutation guards, and test fixture consolidation.

## Lib Audit — Dependency Optimizations

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| LIB-1 | `p-limit` sliding-window concurrency in `data-loader.ts` | P2 | Replaced batch-slice loop with `pLimit(TRACE_QUERY_CONCURRENCY)`. Commit: a68db6a |
| LIB-2 | Add `"d3-array": "^3.2.4"` to `dependencies` | P3 | Zero bundle cost, types now explicit |
| LIB-3 | Replace `groupBy` call sites with non-nullable keyFns using `d3.group` | P3 | `data-loader.ts` migrated to `d3.group`; `workflow-graph.ts` retained custom `groupBy` (nullable keys) |
| LIB-4 | Replace `empiricalCDF` piecewise interpolation with `scaleLinear().domain(...).range(...).clamp(true)` | P3 | Degenerate-domain guard added; clamp replaces manual extrapolation |
| LIB-5 | Replace `result.error.message` with `prettifyError(result.error)` in `dashboard-file-utils.ts` | P3 | `prettifyError` imported from `zod` directly (type-only import unchanged) |
| LIB-6 | Migrate `processBatch()` in `scripts/judge-evaluations.ts` to `pLimit(concurrency)` | P3 | Sliding-window concurrency; per-item `delayMs` delay preserved |
| LIB-7 | Add `pLimit` to `Promise.all(transcripts.map(...))` in `scripts/judge-evaluations.ts` | P3 | `concurrencyLimit = pLimit(CONCURRENCY)` wraps transcript loading |

**Not adopted:** `Map.groupBy` native — blocked by `tsconfig.json` lib target (`ES2022`); requires adding `ES2024.Collection` to lib array + Safari 17.4+ assumption. Use `d3.group` instead.

## Type Safety — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| CR-TS-1 | `spanAttr<T>` replaced with validated type-discriminant overload | P1 | Requires `'string' \| 'number' \| 'boolean'` tag; 44 call sites updated in `sessions.ts` + `agents.ts`; no silent casts. Commit: ddfadde |

## Worker API — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| CR-WK-6 | **KV schema versioning** | P3 | `{ v, data }` envelope written by `sync-to-kv.ts`; `getKv<T>()` in worker unwraps, rejects mismatches, passes legacy entries through. Date: 2026-03-27 |
| CR-WK-9 | `supabasePost` returns `Promise<void>`; all `logActivity` call sites use `ctx.waitUntil` | P4 | Events no longer dropped after response. Date: 2026-03-27 |

## Phase 3 Auth: Code Review Deferred Items

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| AUTH-P3-1 | `RoleViewType` and `DashboardView` unified | P3 | `DashboardView = RoleViewType` alias in `src/types/auth.ts` (pre-existing) |
| AUTH-P3-2 | `VALID_ROLES` in App.tsx now derived from `ROLES` | P3 | `ROLES` = `RoleSchema.options` (pre-existing) |
| AUTH-P3-3 | `authUserId`/`appUserId` made optional in `AppSession` | P4 | Omitted in client `fetchAppSession`. Commit: 9e7bb4e |
| AUTH-P3-4 | Hand-written `MeResponse` interface removed | P3 | Re-exported from `auth-schemas.ts` (pre-existing) |

## Phase 4 Auth: Code Review Deferred Items

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| AUTH-P4-1 | `supabase-rest.ts` extracted with `userAuthHeaders()` and `supabasePost()` helpers | P3 | Commit: 88c7605 |

## Phase 4 Admin: Code Review Deferred Items

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ADMIN-P4-1 | `AdminUserSchema` email made optional | P3 | Phone-auth/OAuth users no longer silently dropped. Commit: 0a3e2c1 |
| ADMIN-P4-2 | `AdminPage` concurrent mutation guard added via `pendingMutations` ref counter | P3 | Commit: 0cc5136 |

## Workflow Visualization — G5 Code Review Deferred Items

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| G5-M1 | `classifyShape` now uses DFS cycle detection | P3 | Correctly handles 3+ node cycles. Commit: cb90cfc |
| FU-G5-FILTER | Agent filter chip bar in `AgentWorkflowView` | P3 | Multi-select toggles filter both DAG (dim) and Timeline (hide lane + handoffs); shown when 2+ agents |
| FU-G5-LAYOUT-LATENCY | Edge labels showing handoff latency on workflow graph | P3 | Computed from `gen_ai.agent.name` span timing; format `"score · Nms"`. Commits: 6a402c8..e9da2ae |

## Regression Detection — R5 (Completed)

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| R5-CR-1 | `coverageDropoutRate` and `latencySkewRatio` fields added to `DegradationSignalsPage` | P3 | Coverage Dropout (%) and Latency Skew columns now rendered in table |
| R5-HOOK | `useDegradationSignals` hook + `DegradationSignalsResponse` types | P3 | Commit: ce7ec1d |
| R5-PAGE | `DegradationSignalsPage` table | P3 | Metric, status, EWMA drift, variance trend, variance ratio, breaches, confirmed. Commits: dbeb1c3..b4e8358 |
| R5-ROUTE | `/degradation-signals` route + `g d` keyboard shortcut | P3 | Wired in `App.tsx`. Commit: 013bba0 |
| R5-DEV-API | `GET /api/degradation-signals` on dev Hono server | P3 | Computes EWMA signals from local eval data via `computeRollingDegradationSignals`. Commit: 680ef9b |

## Test Fixture Consolidation

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| TF-1 | Audited — no local duplicate `makeNode`/`makeGraph` factories | P3 | All tests use `workflow-fixtures.ts`. Commit: f37f38e |
| TF-2 | Inline `WorkflowGraph` literals in `WorkflowGraph.test.tsx` converted to `makeGraph()` calls | P3 | Commit: f37f38e |
| TF-3 | Audited — chain-graph `Array.from` patterns use `makeGraph()` wrapper | P3 | No additional `makeChainGraph` opportunities. Commit: f37f38e |
