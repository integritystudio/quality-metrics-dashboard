# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### G5: Multi-Agent Workflow Visualization — Remaining Work

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-A | WorkflowTimeline swimlane component (per-agent horizontal lanes, handoff markers) | P3 | impl-g5 Phase 4 |
| G5-B | AgentWorkflowView dual-tab container (DAG / Timeline toggle with ARIA tablist) | P3 | impl-g5 Phase 5 |
| G5-C | Navigation link from AgentSessionPage to /workflows/:sessionId | P3 | impl-g5 Phase 5 |
| G5-D | Session list multi-agent badge (indicator on sessions with >1 agent) | P4 | impl-g5 Phase 5 |
| G5-E | Bundle size spike — verify workflow-viz chunk with `npx vite-bundle-visualizer` | P3 | impl-g5 v2.0 |

**Status**: G5-A (daea286), G5-B (daea286), G5-D (b7ee1e5) — Done. G5-E — Audited: workflow-viz chunk is 1,608 KB (499 KB gzip), driven by @xyflow/react + elkjs. WorkflowPage is already lazy-loaded via dynamic import() in App.tsx, isolating the chunk correctly. No further action needed.

### G5: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-WG5 | Turns with undefined `agentName` are silently dropped — add observability counter | P4 | WG-5 |
| G5-WG9 | `durationMs` on WorkflowNode sums nested spans (double-counts wall time) — document or fix | P4 | WG-9 |
| G5-C1 | `agent.name` vs `gen_ai.agent.name` attribute key: route uses former, transformer uses latter — verify both attributes are present on real spans | P3 | WG-C1 |
| G5-M2 | `inferFromSpans` strict `<=` for edge inference misses near-concurrent spans — consider epsilon tolerance | P4 | WG-M2 |
| G5-M4 | `WorkflowEdge.handoffScore` typed as `number` but inferred edges use `0` — consider `number | null` to distinguish from real zero scores | P4 | WG-M4 |

**Status**: G5-C (b30c9f5, pre-existing), G5-C1 (e3c7158), G5-M2 (3e89a64), G5-M4 (ae5a055), G5-WG5 (b30c9f5), G5-WG9 (09640d7) — all Done.

### Phase 4 Admin: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| ADMIN-P4-3 | Admin routes return generic error messages on Supabase REST failures — currently safe (no body exposure), but document error handling policy for consistency with other endpoints | P4 | code-reviewer feedback on c9a38dc |

**Status**: ADMIN-P4-3 (3c1273c) — Done.

### Test Fixture Consolidation

| # | Item | Priority | Source |
|---|------|----------|--------|
| TF-4 | Audit test files for duplicated `@xyflow/react` or `elkjs` mock definitions that could be extracted to a shared mock module | P4 | 431e456 simplify review |
| TF-5 | Audit test files for redundant section-banner comments (`// ---`, `// ===`) where `describe` blocks already provide structure | P4 | 431e456 simplify review |

**Status**: TF-4 — Audited: mocks defined only in `WorkflowGraph.test.tsx`; no duplicates. TF-5 — Audited: banners appear alongside `describe` blocks throughout; retained as visual separators (low value to remove).

### CR: Security — Critical

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-SEC-1 | **Test-token auth bypass in production worker** — `worker/index.ts:98-111` hardcodes `Bearer test-token` granting `dashboard.admin` + all views. Remove entirely or gate behind `TEST_MODE` env var in non-production wrangler env only. | P0 | code-review 2026-03-26 |

### CR: Type Safety — Critical / High

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-TS-1 | **Unsafe `attr<T>` cast in sessions.ts** — `attr<T>()` helper (line 29-31) casts `unknown` to `T` without validation. Used 60+ times. Add type-guard parameter or Zod validation at span parse time. | P1 | code-review 2026-03-26 |
| CR-TS-2 | **Unsafe `as Array<unknown>` casts in worker.ts** — `userRes.json() as Array<unknown>` (lines 144, 162) bypasses TS safety. Replace with `const parsed: unknown = await res.json()` + `Array.isArray()` narrowing. | P1 | code-review 2026-03-26 |
| CR-TS-3 | **Unsafe attribute casts in agents.ts** — `span.attributes?.['gen_ai.agent.name'] as string` (lines 55, 68, 76) without validation. Same pattern as CR-TS-1. | P2 | code-review 2026-03-26 |
| CR-TS-4 | **Double-cast in WorkflowGraph.tsx** — `data as unknown as WorkflowNode` (line 98) without validation. Add Zod parse or explicit type guards on `label`, `durationMs`, etc. | P2 | code-review 2026-03-26 |
| CR-TS-5 | **Unvalidated `buildFromEvaluation` input** — `workflow-graph.ts:25-98` does not validate `MultiAgentEvaluation` structure. If `evaluation.turns` is null, throws. Add safeParse guard. | P2 | code-review 2026-03-26 |

### CR: Error Handling — High / Medium

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-ERR-1 | **Unvalidated date parsing in sessions.ts** — Lines 91-106 parse timestamps via `new Date(str).getTime()` without validation. Invalid strings produce NaN that corrupts `tsMin`/`tsMax` comparisons and `durationHours`. Add `parseTimestamp()` helper with null return for invalid input. | P2 | code-review 2026-03-26 |
| CR-ERR-2 | **Silent Zod safeParse failures in worker.ts** — Lines 224, 237, 261 discard `safeParse` error details. Add `console.error(result.error.issues)` before returning 500. | P3 | code-review 2026-03-26 |
| CR-ERR-3 | **Silent roles-fetch failure in admin route** — `worker/index.ts:517-524` treats failed role fetch as empty array. Should return 500 if `roleRowsRes.ok` is false. | P3 | code-review 2026-03-26 |
| CR-ERR-4 | **Silent fire-and-forget activity logging** — `supabase-rest.ts:26-43` and `activity-logger.ts` swallow all errors. Add conditional `console.warn` in development for audit trail debugging. | P4 | code-review 2026-03-26 |

### CR: Performance / Robustness — Medium

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-PERF-1 | **Unbounded WorkflowTimeline SVG** — `WorkflowTimeline.tsx:137-152` computes SVG width from `totalTurns` with no cap. Sessions with 10K+ turns produce 400KB+ SVG. Add `MAX_VISIBLE_TURNS` limit with pagination. | P3 | code-review 2026-03-26 |
| CR-PERF-2 | **Unbounded ELK layout in WorkflowGraph** — `WorkflowGraph.tsx:73` runs ELK on every node/edge change with no size guard. Large graphs (100+ agents) block main thread. Cap node count or add web worker. | P3 | code-review 2026-03-26 |
| CR-PERF-3 | **WorkflowGraph useEffect dependency array** — `setNodes`/`setEdges` in dependency array are recreated each render, causing unnecessary layout recomputation. Remove from deps. | P4 | code-review 2026-03-26 |

### CR: Auth — High

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-AUTH-1 | **Auto-refresh timer race condition** — `supabase.ts:213-233` uses module-level `autoRefreshTimer` without reference counting. React Strict Mode double-mount or multiple AuthProvider instances can leak timers. Add ref counter to `startAutoRefresh`/`stopAutoRefresh`. | P2 | code-review 2026-03-26 |
| CR-AUTH-2 | **AdminPage mutation counter fragility** — `AdminPage.tsx:59-63` uses numeric ref counter. If a mutation throws before `onMutationEnd`, counter gets stuck. Replace with `Set<string>` of in-flight request IDs. | P3 | code-review 2026-03-26 |

### CR: Style — Low

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-STYLE-1 | **Inline styling in workflow components** — `WorkflowGraph.tsx:104-136`, `AgentWorkflowView.tsx:54-77` use inline `style` objects. Project guideline: no inline styling for UI components. Extract to CSS module. | P4 | code-review 2026-03-26 |

### E2E & Integration Testing

| # | Item | Priority | Source |
|---|------|----------|--------|
| E2E-1 | Create production-aligned integration tests that remove mocked APIs and run E2E tests with Doppler-injected credentials against real dev environment. Current E2E suite uses placeholder Supabase credentials + custom fixture that mocks `/api/me` endpoint (suitable for unit-like testing). Separate integration tests would validate API contracts and auth flow with real Supabase. | P3 | e2e-auth-setup session |

## Completed

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
