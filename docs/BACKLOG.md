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

### G5: Code Review Deferred Items

| # | Item | Priority | Source |
|---|------|----------|--------|
| G5-WG5 | Turns with undefined `agentName` are silently dropped — add observability counter | P4 | WG-5 |
| G5-WG9 | `durationMs` on WorkflowNode sums nested spans (double-counts wall time) — document or fix | P4 | WG-9 |
| G5-C1 | `agent.name` vs `gen_ai.agent.name` attribute key: route uses former, transformer uses latter — verify both attributes are present on real spans | P3 | WG-C1 |
| G5-M1 | `classifyShape` only detects pairwise back-edges; misses 3+ node cycles (A→B→C→A) — needs DFS cycle detection | P3 | WG-M1 |
| G5-M2 | `inferFromSpans` strict `<=` for edge inference misses near-concurrent spans — consider epsilon tolerance | P4 | WG-M2 |
| G5-M4 | `WorkflowEdge.handoffScore` typed as `number` but inferred edges use `0` — consider `number | null` to distinguish from real zero scores | P4 | WG-M4 |

### AUTH: Phase 1 Implementation — Code Review Findings

| # | Item | Priority | Source | Status |
|---|------|----------|--------|--------|
| AUTH-1 | Fix unsafe `AppSession` cast in `fetchAppSession` — only validates 3 fields, casts without checking `roles`/`permissions` arrays | P1 | code-review: e7afb28, 9c1d14b | Done — 894b73b |
| AUTH-2 | Fix `RequireAuth` loading state — returns `null` causing blank screen flash; should return loading skeleton | P1 | code-review: 9c1d14b | Done — 0963fc5 |
| AUTH-3 | Gate protected queries on token availability — missing token fires tokenless request, wastes 3 retry attempts | P1 | code-review: bb6b0b7 | Done — 46f2f16 |
| AUTH-4 | Add automatic token refresh on 401 — no refresh-and-retry path when token expires between read and request | P1 | code-review: bb6b0b7 | Done — a3b8acf |
| AUTH-6 | Silent `appUserId` fallback on `public.users` lookup failure — should return 401 instead of zero-permission session | P2 | code-review: e7afb28 | Done — 6ae89a6 |
| AUTH-7 | `LoginPage` doesn't restore originally requested route — users always land on `/` after sign-in | P2 | code-review: 9c1d14b | Done — a7599cc |
| AUTH-8 | Validate `AuthTokenResponse` shape before casting — `await res.json() as AuthTokenResponse` is unchecked, could produce corrupted session | P2 | code-review: 9c1d14b | Done — ef6e26d |
| AUTH-9 | `getSession()` reads + JSON-parses `localStorage` on every query — use auth state directly instead | P2 | code-review: bb6b0b7 | Done — f827358 |
| AUTH-12 | Add token length check before header interpolation — empty string would produce `Authorization: Bearer ` with blank token | P3 | code-review: bb6b0b7 | Done — beae4b7 |
| AUTH-13 | Add `localhost` to CORS policy for local dev — local `npm run dev` hits CORS failures against worker | P3 | code-review: bb6b0b7 | Done — beae4b7 |
| AUTH-15 | Input validation on `name` path params in metrics/trends routes — `/api/metrics/:name`, `/api/trends/:name` accept unsanitized values as KV keys; inconsistent with `/api/agents/detail/:agentId` which validates | P2 | code-review: 11f4c53 | Done — 398d6eb |
| AUTH-16 | Add explanatory comment on CORS `allowMethods: ['GET']` — affects entire app via `/*` middleware; future maintainers may wonder why POST was removed | P3 | code-review: 11f4c53 | Done — beae4b7 |
| AUTH-17 | Parallelize and timeout Supabase fetches in auth middleware — three sequential unawaited fetches (JWT verify, public.users lookup, user_roles lookup) with no timeout blocks other routes under load | P3 | code-review: 11f4c53 | Done — beae4b7 |
