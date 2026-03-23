# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Phase 3 Auth: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| AUTH-P3-1 | `RoleViewType` and `DashboardView` are structurally identical unions declared independently — unify by making one an alias of the other | P3 | ce1cb6a review |
| AUTH-P3-2 | `VALID_ROLES` in App.tsx hardcodes `['executive', 'operator', 'auditor']` — derive from Zod schema or VIEW_PERMISSION_MAP to avoid silent divergence | P3 | ce1cb6a review |
| AUTH-P3-3 | `authUserId`/`appUserId` set to `''` in fetchAppSession — consider optional or null to make emptiness explicit in the type | P4 | ce1cb6a review |
| AUTH-P3-4 | Dual `MeResponse` types: hand-written interface in `src/types/auth.ts` and Zod-inferred in `auth-schemas.ts` — remove hand-written and re-export from schemas | P3 | ce1cb6a review |

### Phase 4 Auth: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| AUTH-P4-1 | Extract generic Supabase REST client helper (`dashboard/src/lib/supabase-rest.ts`) to unify duplicate POST patterns in `logActivity` and `api-provisioning-sender` | P3 | activity-logging code-simplifier review |

### G5: Multi-Agent Workflow Visualization — Remaining Work

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-A | WorkflowTimeline swimlane component (per-agent horizontal lanes, handoff markers) | P3 | impl-g5 Phase 4 |
| G5-B | AgentWorkflowView dual-tab container (DAG / Timeline toggle with ARIA tablist) | P3 | impl-g5 Phase 5 |
| G5-C | Navigation link from AgentSessionPage to /workflows/:sessionId | P3 | impl-g5 Phase 5 |
| G5-D | Session list multi-agent badge (indicator on sessions with >1 agent) | P4 | impl-g5 Phase 5 |
| G5-E | Bundle size spike — verify workflow-viz chunk with `npx vite-bundle-visualizer` | P3 | impl-g5 v2.0 |

### G5: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-WG5 | Turns with undefined `agentName` are silently dropped — add observability counter | P4 | WG-5 |
| G5-WG9 | `durationMs` on WorkflowNode sums nested spans (double-counts wall time) — document or fix | P4 | WG-9 |
| G5-C1 | `agent.name` vs `gen_ai.agent.name` attribute key: route uses former, transformer uses latter — verify both attributes are present on real spans | P3 | WG-C1 |
| G5-M1 | `classifyShape` only detects pairwise back-edges; misses 3+ node cycles (A→B→C→A) — needs DFS cycle detection | P3 | WG-M1 |
| G5-M2 | `inferFromSpans` strict `<=` for edge inference misses near-concurrent spans — consider epsilon tolerance | P4 | WG-M2 |
| G5-M4 | `WorkflowEdge.handoffScore` typed as `number` but inferred edges use `0` — consider `number | null` to distinguish from real zero scores | P4 | WG-M4 |

### Phase 4 Admin: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| ADMIN-P4-1 | `AdminUserSchema` silently drops users with non-standard emails (phone auth, OAuth) via failed Zod parse — consider logging dropped users or using optional/refinement for email field | P3 | code-reviewer feedback on c9a38dc |
| ADMIN-P4-2 | `AdminPage.tsx` `onChanged` refetch invalidates all users after each role mutation — no concurrent mutation guard, races possible if multiple UserRow components assign/revoke simultaneously | P3 | code-reviewer feedback on c9a38dc |
| ADMIN-P4-3 | Admin routes return generic error messages on Supabase REST failures — currently safe (no body exposure), but document error handling policy for consistency with other endpoints | P4 | code-reviewer feedback on c9a38dc |

### E2E & Integration Testing

| # | Item | Priority | Source |
|---|------|----------|--------|
| E2E-1 | Create production-aligned integration tests that remove mocked APIs and run E2E tests with Doppler-injected credentials against real dev environment. Current E2E suite uses placeholder Supabase credentials + custom fixture that mocks `/api/me` endpoint (suitable for unit-like testing). Separate integration tests would validate API contracts and auth flow with real Supabase. | P3 | e2e-auth-setup session |

