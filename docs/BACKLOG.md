# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### CR: Worker API — Validation / Security (Open Items)

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-WK-6 | **KV data lacks schema versioning** — no version field in KV payloads; schema changes during deploy can cause old cached data to be read with the new schema without detection | P3 | code-review 2026-03-26 |
| CR-WK-9 | **Fire-and-forget audit logging can lose events** — `logActivity` is not awaited (intentionally, for latency); network or Supabase failures are silently swallowed — consider a best-effort retry or dead-letter queue for compliance-critical events | P4 | code-review 2026-03-26 |


### CR: Type Safety — Critical / High (Open Items)

| # | Item | Priority | Source |
|---|------|----------|--------|
| CR-TS-1 | **Unsafe `attr<T>` cast in sessions.ts** — `attr<T>()` helper (line 29-31) casts `unknown` to `T` without validation. Used 60+ times. Add type-guard parameter or Zod validation at span parse time. | P1 | code-review 2026-03-26 |

**Status**: CR-TS-1 open: `attr<T>` has 60+ call sites in sessions.ts; requires a type-guard parameter or Zod schema-per-attribute refactor — deferred as a larger refactor.

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
| FU-G5-FILTER | Agent filter chip bar in `AgentWorkflowView` — multi-select toggles filter both DAG (dim) and Timeline (hide lane + handoffs); shown when 2+ agents | P3 | Done |

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
