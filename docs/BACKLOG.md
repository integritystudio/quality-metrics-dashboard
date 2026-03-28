# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Lib Audit: Dependency Optimizations (2026-03-28)

Findings from repomix-compressed audit + claude-code-guide + web-research-analyst cross-review.
`p-limit` installed and `npm audit` clean as of this session.

| # | Item | Priority | Notes |
|---|------|----------|-------|
| LIB-3 | Replace `groupBy` call sites with non-nullable keyFns using `d3.group` from `d3-array` | P3 | `InternMap extends Map` — type-safe drop-in. Keep custom `groupBy` where null-key skipping is needed |
| LIB-4 | Replace `empiricalCDF` piecewise interpolation (`quality-utils.ts:257`) with `scaleLinear().domain([p10,p25,p50,p75,p90]).range([0.1,0.25,0.5,0.75,0.9]).clamp(true)` | P3 | Add degenerate-domain guard (p25===p50 etc → NaN) before constructing scale |
| LIB-5 | Replace `result.error.message` in `dashboard-file-utils.ts` and error boundaries with `z.prettifyError(result.error)` | P3 | Built into Zod v4 — zero dep. Use `zod-validation-error@^5` only if `instanceof ValidationError` discrimination is needed |

**Not recommended:** `Map.groupBy` native — blocked by `tsconfig.json` lib target (`ES2022`); requires adding `ES2024.Collection` to lib array + Safari 17.4+ assumption. Use `d3.group` instead.

## Completed

### Lib Audit — Resolved

| # | Item | Priority | Status |
|---|------|----------|--------|
| LIB-1 | `p-limit` sliding-window concurrency in `data-loader.ts` — replaced batch-slice loop with `pLimit(TRACE_QUERY_CONCURRENCY)` | P2 | Done (a68db6a) |
| LIB-2 | Add `"d3-array": "^3.2.4"` to `dependencies`; add `"@types/d3-array"` to `devDependencies` | P3 | Done — zero bundle cost, types now explicit |

### Type Safety — Resolved

| # | Item | Priority | Status |
|---|------|----------|--------|
| CR-TS-1 | `spanAttr<T>` replaced with validated type-discriminant overload — requires `'string' \| 'number' \| 'boolean'` tag; 44 call sites updated in `sessions.ts` + `agents.ts`; no silent casts | P1 | Done (ddfadde) |

### Worker API — Resolved

| # | Item | Priority | Status |
|---|------|----------|--------|
| CR-WK-6 | **KV schema versioning** — `{ v, data }` envelope written by `sync-to-kv.ts`; `getKv<T>()` in worker unwraps, rejects mismatches, passes legacy entries through | P3 | Done (2026-03-27) |
| CR-WK-9 | `supabasePost` returns `Promise<void>`; all `logActivity` call sites use `ctx.waitUntil` — events no longer dropped after response | P4 | Done (2026-03-27) |

### Phase 3 Auth: Code Review Deferred Items

| # | Item | Priority | Status |
|---|------|----------|--------|
| AUTH-P3-1 | `RoleViewType` and `DashboardView` unified — `DashboardView = RoleViewType` alias in `src/types/auth.ts` | P3 | Done (pre-existing) |
| AUTH-P3-2 | `VALID_ROLES` in App.tsx now derived from `ROLES` = `RoleSchema.options` | P3 | Done (pre-existing) |
| AUTH-P3-3 | `authUserId`/`appUserId` made optional in `AppSession`; omitted in client `fetchAppSession` | P4 | Done (9e7bb4e) |
| AUTH-P3-4 | Hand-written `MeResponse` interface removed; re-exported from `auth-schemas.ts` | P3 | Done (pre-existing) |

### Phase 4 Auth: Code Review Deferred Items

| # | Item | Priority | Status |
|---|------|----------|--------|
| AUTH-P4-1 | `supabase-rest.ts` extracted with `userAuthHeaders()` and `supabasePost()` helpers | P3 | Done (88c7605) |

### G5: Code Review Deferred Items

| # | Item | Priority | Status |
|---|------|----------|--------|
| G5-M1 | `classifyShape` now uses DFS cycle detection — correctly handles 3+ node cycles | P3 | Done (cb90cfc) |
| FU-G5-FILTER | Agent filter chip bar in `AgentWorkflowView` — multi-select toggles filter both DAG (dim) and Timeline (hide lane + handoffs); shown when 2+ agents | P3 | Done |
| FU-G5-LAYOUT-LATENCY | Edge labels showing handoff latency (`latencyMs`) on workflow graph — computed from `gen_ai.agent.name` span timing; format `"score · Nms"` | P3 | Done (6a402c8..e9da2ae) |

### R5: Regression Detection (Completed)

| # | Item | Priority | Status |
|---|------|----------|--------|
| R5-CR-1 | `coverageDropoutRate` and `latencySkewRatio` fields added to `DegradationSignalsPage` — Coverage Dropout (%) and Latency Skew columns now rendered in table | P3 | Done |
| R5-HOOK | `useDegradationSignals` hook + `DegradationSignalsResponse` types | P3 | Done (ce7ec1d) |
| R5-PAGE | `DegradationSignalsPage` table: metric, status, EWMA drift, variance trend, variance ratio, breaches, confirmed | P3 | Done (dbeb1c3..b4e8358) |
| R5-ROUTE | `/degradation-signals` route + `g d` keyboard shortcut wired in `App.tsx` | P3 | Done (013bba0) |
| R5-DEV-API | `GET /api/degradation-signals` on dev Hono server — computes EWMA signals from local eval data via `computeRollingDegradationSignals` | P3 | Done (680ef9b) |

### Phase 4 Admin: Code Review Deferred Items

| # | Item | Priority | Status |
|---|------|----------|--------|
| ADMIN-P4-1 | `AdminUserSchema` email made optional — phone-auth/OAuth users no longer silently dropped | P3 | Done (0a3e2c1) |
| ADMIN-P4-2 | `AdminPage` concurrent mutation guard added via `pendingMutations` ref counter | P3 | Done (0cc5136) |

### Test Fixture Consolidation

| # | Item | Priority | Status |
|---|------|----------|--------|
| TF-1 | Audited — no local duplicate `makeNode`/`makeGraph` factories found; all tests use `workflow-fixtures.ts` | P3 | Done (f37f38e) |
| TF-2 | Inline `WorkflowGraph` literals in `WorkflowGraph.test.tsx` converted to `makeGraph()` calls | P3 | Done (f37f38e) |
| TF-3 | Audited — chain-graph `Array.from` patterns correctly use `makeGraph()` wrapper; no additional `makeChainGraph` opportunities | P3 | Done (f37f38e) |
