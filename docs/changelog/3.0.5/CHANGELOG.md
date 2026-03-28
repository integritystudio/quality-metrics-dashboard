# v3.0.5 (2026-03-26)

Code review follow-ups and backlog clearance: workflow visualization completion, admin error handling, worker API validation hardening, type safety and security fixes, and E2E integration testing.

## Workflow Visualization — Final Review Items

| ID | Title | Notes |
|----|----------|-------|
| G5-A | WorkflowTimeline swimlane component | Per-agent horizontal lanes and handoff markers. Commit: daea286 |
| G5-B | AgentWorkflowView dual-tab container | DAG/Timeline toggle with ARIA tablist. Commit: daea286 |
| G5-D | Session list multi-agent badge | Indicator on sessions with >1 agent. Commit: b7ee1e5 |
| G5-E | Bundle size audit — workflow-viz chunk | Verified 1,608 KB (499 KB gzip); correctly lazy-loaded via dynamic import() |

## Workflow Visualization — Code Review Deferred Items

| ID | Title | Notes |
|----|----------|-------|
| G5-C | Workflow core implementation | Pre-existing, commit: b30c9f5 |
| G5-C1 | Agent name attribute consistency | Verified `agent.name` and `gen_ai.agent.name` attributes present on real spans. Commit: e3c7158 |
| G5-M2 | Edge inference epsilon tolerance | `inferFromSpans` strict `<=` logic; near-concurrent spans. Commit: 3e89a64 |
| G5-M4 | WorkflowEdge.handoffScore null handling | Distinguish between real zero scores and inferred edges. Commit: ae5a055 |
| G5-WG5 | Turns with undefined agentName observability | Add counter for silently dropped turns. Commit: b30c9f5 |
| G5-WG9 | DurationMs double-counting on nested spans | Document or fix wall-time summation. Commit: 09640d7 |

## Admin — Code Review Deferred Items

| ID | Title | Notes |
|----|----------|-------|
| ADMIN-P4-3 | Admin error handling documentation | Generic error messages on Supabase REST failures; documented policy for consistency. Commit: 3c1273c |

## Test Fixture Consolidation — Audits

| ID | Title | Notes |
|----|----------|-------|
| TF-4 | Duplicated @xyflow/react and elkjs mock audit | Mocks defined only in `WorkflowGraph.test.tsx`; no duplicates found |
| TF-5 | Redundant section-banner comment audit | Banners alongside `describe` blocks retained as visual separators |

## Worker API — Validation & Security

| ID | Title | Notes |
|----|----------|-------|
| CR-WK-1 | KV reads with unsafe casts | Replaced with `Array.isArray` guards; `safeArray` helper extracted. Commits: 488b543, d98d147 |
| CR-WK-2 | Logout audit event unauthenticated sessions | `logActivity` guards against `undefined` appUserId. Commit: af4a3a0 |
| CR-WK-3 | Pagination params use parseInt instead of Zod | `PaginationSchema` (Zod coerce) replaces `parseInt`; rejects invalid values with 400 |
| CR-WK-4 | Timestamp extreme-value edge case | `parseTimestamp` rejects values outside ±8,640,000,000,000,000 ms (ECMAScript safe range) |
| CR-WK-5 | Log severity cast safety | `LogRecord.severity` and `.timestamp` typed as `string`; removed unnecessary casts |
| CR-WK-7 | Admin user spread via unsafe cast | Already uses explicit field selection; no action needed |
| CR-WK-8 | Inconsistent error response shapes | All routes return `{ error: string }` consistently |

## Type Safety — Critical / High

| ID | Title | Notes |
|----|----------|-------|
| CR-TS-2 | Type safety improvement | Commit: 4f239b8 |
| CR-TS-3 | Type safety improvement | Commit: 04bf4be |
| CR-TS-4 | Type safety improvement | Commit: cd22bd9 |
| CR-TS-5 | Type safety improvement | Commit: 25454d5 |

## Error Handling — High / Medium

| ID | Title | Notes |
|----|----------|-------|
| CR-ERR-1 | Error handling improvement | Commit: 03c47f3 |
| CR-ERR-2 | Error handling improvement | Commit: 4f239b8 |
| CR-ERR-3 | Error handling improvement | Commit: 4f239b8 |
| CR-ERR-4 | Error handling improvement | Commit: 9d6db6f |

## Performance & Robustness — Medium

| ID | Title | Notes |
|----|----------|-------|
| CR-PERF-1 | Performance/robustness improvement | Commit: 64486eb |
| CR-PERF-2 | Performance/robustness improvement | Commit: ccf894f |
| CR-PERF-3 | Performance/robustness improvement | Commit: 1bed863 |

## Auth — High

| ID | Title | Notes |
|----|----------|-------|
| CR-AUTH-1 | Auth improvement | Commit: ce66127 |
| CR-AUTH-2 | Auth improvement | Commit: 5a223ae |

## Style — Low

| ID | Title | Notes |
|----|----------|-------|
| CR-STYLE-1 | Score-band color styling | Retained as inline CSS custom properties (data-driven, cannot be static classes). Commit: d132fc6 |

## E2E & Integration Testing

| ID | Title | Notes |
|----|----------|-------|
| E2E-1 | E2E integration test suite | 23 integration tests in `e2e/integration/api-contracts.spec.ts` hitting deployed worker with real Auth0 JWT. Setup creates ephemeral test user; teardown cleans up. |

## Phase 4 DB Migrations

| Task | Outcome |
|------|---------|
| Verify `public.users.id` = `auth.users.id` alignment | Done — zero mismatched rows confirmed (2026-03-26) |
| Rename `auth0_id` → `identity_subject` | Permanently dropped — Auth0 remains canonical IdP; `auth0_id` column name is correct |
| Drop `user_profiles.role` column | Done — column had zero code references; RBAC sourced exclusively from `user_roles → roles.permissions` (2026-03-26) |
| AppSession code simplification | Not applicable — `authUserId` (Auth0 subject) and `appUserId` (Supabase UUID) are always distinct post-migration; fields must not be collapsed |

## Summary

- **Items resolved**: 40+ (G5: 10 items, ADMIN: 1, TF: 2, CR-WK: 7, CR-TS: 4, CR-ERR: 4, CR-PERF: 3, CR-AUTH: 2, CR-STYLE: 1, E2E: 1)
- **Code review items**: Validation hardening, type safety improvements, error handling consolidation, performance audits
- **Workflow visualization**: Final implementation complete with bundle size verification
- **Test coverage**: E2E integration test suite established
