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
| CR-SEC-1 | ~~Test-token auth bypass in production worker~~ — Resolved: gated behind `ALLOW_TEST_BYPASS` env binding (absent in production wrangler.toml). Tests set it via `makeEnv()`. Documented in README.md and parent CLAUDE.md. | P0 | code-review 2026-03-26 |

### CR: Type Safety — Critical / High

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-TS-1 | **Unsafe `attr<T>` cast in sessions.ts** — `attr<T>()` helper (line 29-31) casts `unknown` to `T` without validation. Used 60+ times. Add type-guard parameter or Zod validation at span parse time. | P1 | code-review 2026-03-26 |

**Status**: CR-TS-2 (4f239b8), CR-TS-3 (04bf4be), CR-TS-4 (cd22bd9), CR-TS-5 (25454d5) — Done. CR-TS-1 open: attr<T> has 60+ call sites in sessions.ts; requires a type-guard parameter or Zod schema-per-attribute refactor — deferred as a larger refactor.

### CR: Error Handling — High / Medium

**Status**: CR-ERR-1 (03c47f3), CR-ERR-2 (4f239b8), CR-ERR-3 (4f239b8), CR-ERR-4 (9d6db6f) — all Done.

### CR: Performance / Robustness — Medium

**Status**: CR-PERF-1 (64486eb), CR-PERF-2 (ccf894f), CR-PERF-3 (1bed863) — all Done.

### CR: Auth — High

**Status**: CR-AUTH-1 (ce66127), CR-AUTH-2 (5a223ae) — both Done.

### CR: Style — Low

**Status**: CR-STYLE-1 (d132fc6) — Done. Score-band colors retained as inline CSS custom properties (data-driven, cannot be static classes).

### E2E & Integration Testing

**Status**: E2E-1 — Done. 23 integration tests in `e2e/integration/api-contracts.spec.ts` hitting deployed worker with real Auth0 JWT. Setup creates ephemeral test user with `e2e-dashboard-reader` role; teardown cleans up. Run: `doppler run --project integrity-studio --config dev -- npm run test:e2e:integration`

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
