# v3.0.9 (2026-10-05)

Closes 27 completed backlog items spanning route testing, UI correctness, API client refactoring, staff admin views, key rotation mechanics, and type-safety gates. Focus: lazy-load recovery from deploys, ORG-ID validation parity, org-membership gates, and ADMIN-CUSTOMER-VIEW rollout from gateway CR63 (2026-10-06).

## Testing — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ROUTE-TESTS-MOCK-FREE | Exercise API routes against a local HTTP fixture instead of `vi.mock` | P3 | Done 2026-09-22 — commit 25512fd |

**What the mocks cost, measured rather than asserted.** `/api/agents` returned **500 on every
request** from whenever the route was written until 2026-09-14 (PR #6). Thirteen route test files
were green throughout. They had to be: `queryTraces` is mocked, so the parent's Zod schema — the
thing that rejected the route's date-only `'YYYY-MM-DD'` bound — never ran in a single test. The
defect was only visible by starting the real server and issuing a real request. A mock of a
validating collaborator deletes the validation, and with it the only check that would have caught
this class of bug.

The repo already carries the same lesson in prose. `src/__tests__/api-agents.test.ts`'s own header
records that mocking `buildWorkflowGraph` "made the graph assertions tautological (return X, assert
X) while the real construction never ran", and leaves it unmocked for that reason. This item is
that reasoning applied to the remaining collaborators.

**The seam already exists — no production change needed.** `CloudBackend`'s constructor takes
`baseUrl` and otherwise reads `OBTOOL_API_URL`, so a test can point it at a local stub HTTP server
serving canned `/v1/traces`, `/v1/logs` and `/v1/evaluations` payloads, and then exercise the real
route → `data-loader` → `CloudBackend` → HTTP path end to end. Note `getBackend()` memoises the
instance at module scope (`backend ??= new CloudBackend(...)`), so the env var has to be set before
the first call; vitest's per-file module isolation gives that for free.

**Where mocks should stay.** Error-path tests that need a collaborator to throw on demand are
clearer with a stub than with a fixture server rigged to fail. The target is the happy-path and
shape assertions, which are the ones a real payload makes honest. `error-sanitizer` is a special
case worth fixing early: it is mocked to `String(err)` in 11 files, meaning no test covers what the
route actually returns to a client.

**Acceptance.** A route test suite that fails if the parent's request schemas reject what a route
sends — i.e. one that would have caught the `/api/agents` 500 — with fixtures typed off the
loaders' return types so they stay drift-detecting rather than merely plausible. Must not reach the
real cloud API: the fixture server is local, and a test run with `OBTOOL_API_URL` unset should fail
loudly rather than silently fall through to a live endpoint.

## Behaviour — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| NO-DATA-404-RENDERS-AS-ERROR | An org with no KV keys gets "Failed to load — API error: 404" instead of the no-data state | P2 | Done 2026-09-22 — commit 77ef484 |
| LOGIN-ACTIVITY-NEVER-RECORDED | `user_activity` has 8 `logout` rows and 0 `login` rows against 235 dashboard views | P3 | Done 2026-09-22 — commit 116007b |

**NO-DATA-404-RENDERS-AS-ERROR.** Under org scoping, `/api/dashboard` answers `404 ERR_NO_DATA` when the
active org has no `org:<id>:dashboard:7d` key — by design, and true today for every org except home
(`team-inventoryai-io` and `alyshia-ledlie` have zero `org:` keys; home has 173,530). `useApiQuery.ts`
turns any non-2xx into `throw new Error('API error: 404 …')`, and `DashboardPage` shows that string;
the friendly `no_data` rendering fires only on a 200 body with `overallStatus: "no_data"`. So the first
thing a freshly provisioned tenant sees is an error page for a state the backend considers normal.
Staff were spared only because all nine were pinned to home on 2026-09-18. Fix: treat
`ERR_NO_DATA` (404 with that body) as the no-data state in the loader, not as a failure; keep every
other 404 an error. Acceptance: a session whose active org has no keys renders the same no-data view
as a 200 `no_data` body, and `useApiQuery` tests cover the 404-with-`ERR_NO_DATA` branch.

**LOGIN-ACTIVITY-NEVER-RECORDED.** `docs/auth/user-authentication.md` lists `login` among the
fire-and-forget `user_activity` writes, and the worker accepts it (`FRONTEND_ACTIVITY_EVENTS` in
`auth-schemas.ts`). Nothing sends it: `AuthContext.tsx` has no `login`/`SIGNED_IN` activity call,
while `logout` is recorded (8 rows). Every "when did this user last sign in" answer therefore comes
from Auth0's `last_login`, which Supabase's `users.last_login` also never receives (landing page UA02).
Fix: post `login` once when the Auth0 SDK reports an authenticated session for the first time in a
page load, mirroring the `logout` call. Acceptance: one sign-in produces exactly one `login` row.

## Workflow page — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| WORKFLOW-GRAPH-ONLY-ENDPOINT | `WorkflowPage` fetches the full agent session to render only the graph | P3 | Done 2026-10-05 — commits fd50a4f, 5133898. `GET /api/agents/:sessionId/graph` on the Worker (same KV key, no `evaluations`) and the local API (no evaluations lookup); see note |
| AGENT-QUERY-PARAM-UNREAD | `?agent=` on `/agents/:sessionId` is written by `WorkflowPage` but read by nothing | P3 | Done 2026-10-05 — commits d0845b5, 9950ec1. Decided: focus. `AgentSessionPage` highlights that agent's turns and scrolls the first into view |
| WORKFLOW-TEST-DEEP-MOCK | `WorkflowPage.test.tsx` mocks `WorkflowGraphView`, two levels below the page | P3 | Done 2026-10-05 — commit 403cbe6. Click forwarding moved to the `AgentWorkflowView` tests |
| AGENT-SESSION-TEST-MISPLACED | `AgentSessionPage`'s "View Workflow" test lives in `WorkflowPage.test.tsx` | P3 | Done 2026-10-05 — commit 22ce360. The new file mocks only `useAgentSession` |

**WORKFLOW-GRAPH-ONLY-ENDPOINT.** `useAgentSession` calls `GET /api/agents/:sessionId`
(`src/api/routes/agents.ts`), which returns every span with its `attributes`, runs
`loadEvaluationsByTraceIds` for `evaluations`, and builds `agentMap`. `WorkflowPage` reads only
`graph` and `evaluation`, so the extra storage read, the payload and the JSON parse all scale with
span count for nothing. Fix: a `GET /api/agents/:sessionId/graph` route (or a `?fields=` option) that
still builds the graph from spans server-side but skips the evaluations lookup and omits
`spans`/`evaluations`/`agentMap`. Trade-off: the page currently shares the `['agent-session', id]`
query cache with `AgentSessionPage`, so a node click lands on a warm cache; a slim endpoint makes that
click a full fetch. Acceptance: the workflow view's response carries no `spans` array, and the
node-click drill-in still renders.
*Closed 2026-10-05.* The description above is the local API's. In production the Worker already
answered `spans: []` from one KV key, so there the saving is the session's `evaluations` array, not a
storage read: the graph route reads the same `session:<id>` key and drops that array.

**AGENT-QUERY-PARAM-UNREAD.** Clicking a graph node navigates to
`routes.agentSession(sessionId, nodeId)` → `/agents/:sessionId?agent=<nodeId>`, but no page reads
the param — only `LoginPage` and `EvaluationDetailPage` call `useSearch`. So the click lands on the
session page with no agent selected or highlighted. Decide: either `AgentSessionPage` reads `agent`
and focuses that agent (scroll/highlight its turns), or the param is dropped from the builder.
Acceptance: the param either changes what `AgentSessionPage` renders, with a test, or no longer exists.

**WORKFLOW-TEST-DEEP-MOCK.** The page renders `AgentWorkflowView`, which renders `WorkflowGraphView`;
the test mocks the latter, so it depends on `AgentWorkflowView`'s tab default and internals and imports
`WorkflowGraphViewProps`. Mocking `../components/AgentWorkflowView.js` would isolate the page to what
it passes (`graph`, `evaluation`, `onNodeClick`). Left as-is because the current mock also exercises
`AgentWorkflowView`'s real code; if that coverage matters, move it to an `AgentWorkflowView` test
first. Acceptance: the page test mocks only the page's direct children.

**AGENT-SESSION-TEST-MISPLACED.** The `describe('AgentSessionPage')` block (the "View Workflow" link →
`routes.workflow(sessionId)`) sits in `WorkflowPage.test.tsx` because it shares that file's mocks.
Move it to an `AgentSessionPage` test file alongside the page's other coverage. Acceptance:
`WorkflowPage.test.tsx` tests only `WorkflowPage`.

## API client — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ORG-SWITCH-REFETCHES-OLD-ORG | `switchOrg` refetches every mounted query under the old org before fetching the new one | P3 | Done 2026-09-30 — commit 4c4b594 |
| QUERYFN-DROPS-ABORT-SIGNAL | `useApiQuery` and `useTrace` never abort a request whose key has moved on | P3 | Done 2026-09-30 — commit f767bca |
| AUTH-FETCHES-BYPASS-API-CLIENT | `/api/me`, `/api/logout` and `/api/activity` build `Authorization` by hand | P3 | Done 2026-09-30 — commit 1b4b9fc. `supabase-rest.ts`'s service-role `Bearer` is a different scheme and stays |
| ADMIN-FETCH-DUPLICATED | `adminFetch` and `memberFetch` in `AdminPage` have identical bodies | P3 | Done 2026-09-30 — commit 6d4f3aa |
| ORG-ID-UUID-CHECKS-DISAGREE | The org-id header check and the org-id Zod schemas accept different ids | P3 | Done 2026-09-30 — commit 81d78fd. Schemas loosened to `UUID_PATTERN` (all ids, not only org) |

**ORG-SWITCH-REFETCHES-OLD-ORG.** `switchOrg` (`src/contexts/OrgContext.tsx:68`) calls
`queryClient.invalidateQueries()` with no filter right after `setChosenOrgId`, before React re-renders.
Its default `refetchType: 'active'` refetches every mounted query, and those are still the old org's:
their `queryFn` closures hold the old `activeOrgId`, so each sends the old `X-Org-Id`. The re-render then
moves every key to the new org (`useApiQuery.ts:65` and `useTrace.ts:31` both lead with the org id) and
fetches again. Each switch therefore costs one wasted round trip per mounted query, `switchOrg` does not
resolve until they finish, and the results are cached under keys that are reused only on a switch back.
The comment above the call says "Drop every cached query", which is not what `invalidateQueries` does.
Fix: `queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== orgId })`, or
`invalidateQueries({ refetchType: 'none' })` to keep the mark-stale behaviour; the key change triggers
the fetches that are needed, once. Acceptance: a test counting fetches across a switch sees one request
per mounted query, each carrying the new org's `X-Org-Id`.

**QUERYFN-DROPS-ABORT-SIGNAL.** The `queryFn`s in `useApiQuery` (`src/hooks/useApiQuery.ts:66`) and
`useTrace` (`src/hooks/useTrace.ts:32`) ignore React Query's `{ signal }`, so a request whose key has
moved on (a period or role change, a new `traceId`, an org switch) runs to completion and is parsed
anyway. `apiFetch` already forwards `signal` through `init`. Fix:
`queryFn: async ({ signal }) => … apiFetch(url, token, activeOrgId, { signal })`. Acceptance: a test that
changes the key mid-flight sees the first request aborted.

**AUTH-FETCHES-BYPASS-API-CLIENT.** Three fetches write `Authorization: Bearer` themselves instead of
going through `apiFetch`: `/api/me` (`src/contexts/AuthContext.tsx:24`), `/api/logout`
(`AuthContext.tsx:119`) and `/api/activity` (`src/lib/activity-logger.ts:19`). None sends `X-Org-Id`
today, and `apiFetch(url, jwt, null, init)` reproduces that exactly. Until they move, a header every
worker request needs would miss these three; `api-client.ts`'s header comment was narrowed to "every
org-scoped fetch" on 2026-09-30 so that it stays true. ADMIN-CV-API-CLIENT's option (A) needs an
Authorization-only fetch path too, so one helper could serve both. Acceptance: no `Bearer` template
literal left in non-test `src/` code outside `api-client.ts`.

**ADMIN-FETCH-DUPLICATED.** `adminFetch` (`src/pages/AdminPage.tsx:77`) and `memberFetch`
(`AdminPage.tsx:189`) have identical bodies: fetch a token, call `apiFetch` with the active org, set a
JSON content type, stringify an optional body. Fix: one hook in `AdminPage` (e.g. `useAdminFetch()`)
that returns the function. Acceptance: one definition, used by both call sites.

**ORG-ID-UUID-CHECKS-DISAGREE.** Two rules guard the same org id. The worker's `X-Org-Id` check and the
client's stored-id check use `UUID_PATTERN` (`src/lib/worker-contract.ts`), which accepts any
8-4-4-4-12 hex string. `OrgMembershipSummarySchema` and `OrgSwitchRequestSchema`
(`src/lib/validation/auth-schemas.ts:61`, `:70`) use `z.string().uuid()`, which in Zod 4.4.3 also checks
the version and variant digits. Checked 2026-09-30: `11111111-1111-1111-1111-111111111111` passes the
pattern and fails the schema, while a v4 id passes both. An id like that would be accepted as a header
but rejected in the switch body, and would fail the `/api/me` parse, which drops the session. Supabase
issues v4 ids, so production is unaffected; fixtures and seeded orgs are where it would surface. Fix:
pick one rule. `z.guid()` matches `UUID_PATTERN` exactly; alternatively, tighten the pattern to Zod's.
Acceptance: one definition, used by both the pattern checks and the schemas.

## Admin customer view — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ADMIN-CUSTOMER-VIEW | Epic: staff can see any org's dashboard, Billing, Usage, Quota and Entitlements exactly as the customer sees them | P2 | **Done and live 2026-10-06** — merged `c0440fd`, CI deploy 37406976214; gateway CR63 version `25e72a57`. Acceptance measured the same night, see below |
| ADMIN-CV-GATEWAY-READ | No read path lets a staff member load another org's customer data without billing that org | P2 | Done 2026-10-06 — IntegrityLandingPage `705fa389` (CR63), live as version `25e72a57` |
| ADMIN-CV-STAFF-GATE | Gate the admin customer view on `isStaff`, not `dashboard.admin` | P2 | Done 2026-10-06 — commit 70a474a |
| ADMIN-CV-API-CLIENT | Client and hooks for the customer-data endpoints, reusing the Auth0 token, never sending `X-Org-Id` cross-origin | P2 | Done 2026-10-06 — commit 5c14b2e |
| ADMIN-CV-LAYOUT-NAV | Admin customer-view routes, shared layout, and back links that return to the admin hub | P2 | Done 2026-10-06 — commits 70a474a, 76ed8b0 |
| ADMIN-CV-HUB | Admin hub: org directory, org switcher, five nav cards | P2 | Done 2026-10-06 — commit 76ed8b0 |
| ADMIN-CV-BILLING | Billing Status screen clone | P2 | Done 2026-10-06 — commit 76ed8b0 |
| ADMIN-CV-USAGE | Usage Summary screen clone: usage bar, daily chart, per-metric table, 30 s poll | P2 | Done 2026-10-06 — commit 76ed8b0; follows the post-CR52 Flutter page, see note |
| ADMIN-CV-QUOTA | Quota Status screen clone | P2 | Done 2026-10-06 — commit 76ed8b0 |
| ADMIN-CV-ENTITLEMENTS | Entitlements screen clone | P2 | Done 2026-10-06 — commit 76ed8b0 |
| ADMIN-CV-PARITY-TESTS | Contract and parity tests that pin the clone to the gateway's wire shapes and the Flutter behaviour | P2 | Done 2026-10-06 — commit 4309362; the gateway-side key pin is in CR63's `admin.test.ts` |
| ADMIN-CV-CORS-AUDIENCE | Verify CORS, issuer and audience pairing for the chosen read path in prod and dev | P3 | Done 2026-10-06 — dev 2026-10-04; production: a staff browser session on `integritystudio.dev` read `api.integritystudio.dev/v1/admin/orgs/…` at 03:03:08Z (gateway audit row 7), after an unauthenticated preflight 204 and 401 probe |

**Closed 2026-10-06 — what was decided, and how acceptance was measured.** Every child is code-complete and tested (1026 unit tests green, e2e 36 passed / 7 data skips, gateway 422 green) and live. *Acceptance, measured 2026-10-06 03:03–03:07Z against org `f4286657…` (home):* a staff member opened the hub and seven orgs' screens from a production browser session; the org's `usage_events` count stayed at 5 (newest 2026-09-29) and **no `usage_events` row was written anywhere** across the Quota, Usage (a minute of 30 s polls) and Quota screens; the gateway wrote exactly one `admin.org_viewed` row per org opened (rows 2–8) and none for the polls; the Quota screen's `minuteUsed`/`monthlyUsed` were read before and after by the owner. Ship history follows. *Ship, in order:* (1) ✅ done 2026-10-06 — api-gateway deployed from `705fa389` (CR63), version `25e72a57`; preflight 204 and 401-not-404 on the admin paths probed live; (2) this branch → the three dashboard Workers — **dev done 2026-10-06**: `quality-metrics-api-dev` version `309cd9cd` from `454cd04`, built under Doppler `dev` so the dev tenant and `api-gateway-dev` are embedded together (checked in the served chunk), `/admin/customers` deep link 200, and `api-gateway-dev` echoes this origin on preflight — the first dev browser sign-in also needed the Worker origin on the dev SPA client's allowlists and refresh token rotation enabled there, both done the same day; **production done 2026-10-06**: `obs-toolkit-quality-metrics-api` version `1a1107cc` and `quality-metrics-api` version `51bf01ca` from `520bf89`, built under Doppler `prd` (production tenant and gateway only in the bundle), `integritystudio.dev/admin/customers` 200, the served `CustomerCard` chunk embeds `https://api.integritystudio.dev`, and the production gateway echoes this origin on preflight — **superseded minutes later** by the merge of this branch to `main` (`c0440fd`, through `520bf89`) and `deploy.yml` run 37406976214 at 03:01Z, which rebuilt and redeployed both Workers from CI; the first authenticated admin read (audit row 7, 03:03:08Z, Quota screen) landed on that build. An open tab from the earlier deploy then failed on `AdminCustomerQuotaPage-*.js`, see LAZY-CHUNK-STALE-AFTER-DEPLOY; (3) a staff member opens `/admin/customers` in production, which is the authenticated GET CORS-AUDIENCE still needs — then read one customer's `usage_events` count and quota `minuteUsed`/`monthlyUsed` before and after ten admin reads. Decisions on the open questions: **staff source** is a `STAFF_USER_IDS` copy in the gateway's `wrangler.toml` (an Auth0 claim would land in the Action CR62 is editing; no Supabase table exists) — the two lists drift unless changed together, nothing checks them; **hub search** not built; **Observability card** calls `switchOrg(viewedOrg)` then `/` — the only way staff reach a non-member org's observability, since the switcher lists memberships only; **uninitialized quota** renders as the customer sees it plus one admin-only line; **"N/A"** kept. **The Usage spec above is stale as of CR52 (2026-09-29):** the Flutter page no longer passes `monthlyUnitsQuota: 0` — it fetches quota itself, draws the usage bar from `monthlyUsed`/`monthlyLimit`, labels the reset date and raises the 0.75/0.90 alerts, and refuses a plan-less quota so the last accepted one stays; the clone does the same (`useAdminUsageQuota`). Billing's `role` is `null` on the staff route. Parity strings and thresholds live in `src/lib/admin-customer-strings.ts` / `-constants.ts` with Dart citations, pinned by `admin-customer-parity.test.ts`.

## Security — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| AUTH-NO-ORG-LEGACY-SESSION | A signed-in user with no org membership gets a legacy global session and reads bare-key (pre-tenancy) KV data | P1 | Done 2026-10-01 — commit 6579b2c. Pinned by `worker/__tests__/org-auth-no-membership.test.ts`; live once the three workers are redeployed |

**AUTH-NO-ORG-LEGACY-SESSION.** In `worker/index.ts` (~417-434) the org path is skipped when the user has
no membership and is not staff, and the "Legacy fallback (Risk 13, no lockout)" only refuses when
`roles.length === 0`. Every new `public.users` row fires the `on_user_created` trigger
(`assign_default_role`, IntegrityLandingPage `supabase/migrations/20260717000000_*`), which gives it the
`provisioned-dashboard-viewer` role, so **every signed-in user who has not yet provisioned an org** lands on
the legacy path: a session with no `activeOrgId`, and `getSessionKv` (~483) reads the bare keys that are
still dual-written for the home org until the P8 cleanup. Reachable today by anyone who signs up through
Universal Login on this app, and from 2026-09-29 through integritystudio.ai as well (its sign-in moves to the
same SPA client). Fix: refuse (`403 ERR_NO_ORG`) any non-staff session without an active org membership,
whatever its roles; the "no lockout" concern it guarded is gone now that every provisioned user has a
membership. Acceptance: a user with a viewer role and no membership gets 403 from every data route; a test
pins it; staff and members are unaffected.

## Tooling and config — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| JUDGE-CLIENT-TEXTSTREAM | `scripts/judge-anthropic-client.ts` no longer type-checks against the parent's `@types/node` 26.6.3 | P3 | Done 2026-10-05 — commit c719785. The #101 cast; drop it with undici 8 |
| SCRIPTS-TYPECHECK-WINDOW | `src/lib/api-client.ts` uses `window`, which the scripts config cannot see | P4 | Done 2026-10-05 — commit c348906. `globalThis.localStorage`; pinned by `api-client-storage.test.ts` (2bc97d8) |
| LAZY-CHUNK-STALE-AFTER-DEPLOY | A tab open across a deploy fails on its next lazy route with "Failed to fetch dynamically imported module" and shows the error boundary | P3 | Done 2026-10-05 — commits 51a4f11, 949eeca. `lazyWithReload` wraps the loader, not `vite:preloadError`, which only Vite's build-time preload helper dispatches |

**JUDGE-CLIENT-TEXTSTREAM.** `scripts/judge-anthropic-client.ts:28` fails with TS2322: undici's `Response` is
missing `textStream`.
- **Cause.** Parent #101 moved the parent to `@types/node` 26.6.3. Its `undici-types` 8.9 adds `textStream()`
  to the global `Response`, and the scripts typecheck resolves that global through the parent's install. The
  wrapped fetch returns undici 7.29.0's `Response` (this app's own copy), which lacks the method.
- **Same defect upstream.** The parent hit it in `src/lib/core/http1-fetch.ts`, fixed it with a one-line cast
  in #101, and then removed the cast in #103 when it moved to undici 8.
- **Fix.** Either cast the return as #101 did, or move this app to undici 8. The judge client uses undici's own
  `fetch` and `Agent`, so it does not hit the built-in-fetch handler break that #103 fixed in the parent.

Acceptance: `typecheck:scripts` reports no error in this file.

**SCRIPTS-TYPECHECK-WINDOW.** `tsconfig.scripts.json` sets `lib: ["ES2022"]` (no DOM) and includes
`src/lib`. So `getStoredOrgId` and `setStoredOrgId` (`src/lib/api-client.ts:19`, `:31`) fail with "Cannot find
name 'window'".
- **Not from this session's refactor.** The pre-refactor file (`00c07e0^`) fails the same way under that
  config, and the `window.localStorage` calls date from 2026-08-14. Dashboard #11's description attributed it
  to the 2026-09-30 refactor.
- **Fix.** Read the store through `globalThis.localStorage`; the existing `try`/`catch` already covers a
  runtime without it.
- **Alternative.** Exclude `src/lib/api-client.ts` from the scripts config, since no script imports it.

Acceptance: `typecheck:scripts` reports no error in `src/lib`.

**LAZY-CHUNK-STALE-AFTER-DEPLOY.** Every deploy replaces the asset manifest, and chunk names carry content hashes, so a shell loaded before the deploy asks for chunk names that no longer exist. With `not_found_handling = "single-page-application"` the Worker answers such a request with `index.html`, the browser rejects HTML as a module, and `RouteErrorFallback` shows "Failed to fetch dynamically imported module". Seen the first time the admin customer view was used in production: a tab from the 03:00Z manual deploy hit the 03:01Z CI redeploy. `WorkflowPage` has been lazy since before this and had the same exposure. *Fix:* catch the failure in the lazy loaders (or at `RouteErrorFallback`) and reload the page once — Vite's `vite:preloadError` event exists for exactly this — guarded against a reload loop. *Acceptance:* a test that a rejected `import()` triggers one reload and a second rejection shows the fallback.
