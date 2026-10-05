# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ~~ROUTE-TESTS-MOCK-FREE~~ | ~~Exercise API routes against a local HTTP fixture instead of `vi.mock`~~ | ~~P3~~ | Done 2026-09-22 — commit 25512fd |

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

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ~~NO-DATA-404-RENDERS-AS-ERROR~~ | ~~An org with no KV keys gets "Failed to load — API error: 404" instead of the no-data state~~ | ~~P2~~ | Done 2026-09-22 — commit 77ef484 |
| ~~LOGIN-ACTIVITY-NEVER-RECORDED~~ | ~~`user_activity` has 8 `logout` rows and 0 `login` rows against 235 dashboard views~~ | ~~P3~~ | Done 2026-09-22 — commit 116007b |

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

### Workflow page

Deferred from the 2026-09-26 `/simplify` pass on `WorkflowPage` (commit 01f8e25).

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| WORKFLOW-GRAPH-ONLY-ENDPOINT | `WorkflowPage` fetches the full agent session to render only the graph | P3 | API + hook change |
| AGENT-QUERY-PARAM-UNREAD | `?agent=` on `/agents/:sessionId` is written by `WorkflowPage` but read by nothing | P3 | Behaviour decision |
| WORKFLOW-TEST-DEEP-MOCK | `WorkflowPage.test.tsx` mocks `WorkflowGraphView`, two levels below the page | P3 | Test-only |
| AGENT-SESSION-TEST-MISPLACED | `AgentSessionPage`'s "View Workflow" test lives in `WorkflowPage.test.tsx` | P3 | Test-only |

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

### API client

Deferred from the 2026-09-30 `/simplify` pass on `src/lib/api-client.ts`, which moved the shared wire
values into `src/lib/worker-contract.ts`. Each item below is in a caller, outside that file.

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ~~ORG-SWITCH-REFETCHES-OLD-ORG~~ | ~~`switchOrg` refetches every mounted query under the old org before fetching the new one~~ | ~~P3~~ | Done 2026-09-30 — commit 4c4b594 |
| ~~QUERYFN-DROPS-ABORT-SIGNAL~~ | ~~`useApiQuery` and `useTrace` never abort a request whose key has moved on~~ | ~~P3~~ | Done 2026-09-30 — commit f767bca |
| ~~AUTH-FETCHES-BYPASS-API-CLIENT~~ | ~~`/api/me`, `/api/logout` and `/api/activity` build `Authorization` by hand~~ | ~~P3~~ | Done 2026-09-30 — commit 1b4b9fc. `supabase-rest.ts`'s service-role `Bearer` is a different scheme and stays |
| ~~ADMIN-FETCH-DUPLICATED~~ | ~~`adminFetch` and `memberFetch` in `AdminPage` have identical bodies~~ | ~~P3~~ | Done 2026-09-30 — commit 6d4f3aa |
| ~~ORG-ID-UUID-CHECKS-DISAGREE~~ | ~~The org-id header check and the org-id Zod schemas accept different ids~~ | ~~P3~~ | Done 2026-09-30 — commit 81d78fd. Schemas loosened to `UUID_PATTERN` (all ids, not only org) |

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

### Admin customer view

Filed 2026-09-29. A staff-only clone of the customer dashboard at `integritystudio.ai/dashboard`
(Flutter, IntegrityLandingPage repo) and its four linked pages, inside this app. Source paths below
are in that repo unless prefixed `dashboard/`.

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ADMIN-CUSTOMER-VIEW | Epic: staff can see any org's dashboard, Billing, Usage, Quota and Entitlements exactly as the customer sees them | P2 | Parent of the items below |
| ADMIN-CV-GATEWAY-READ | No read path lets a staff member load another org's customer data without billing that org | P2 | Blocker. Option (A) chosen 2026-10-04; routes not built |
| ADMIN-CV-STAFF-GATE | Gate the admin customer view on `isStaff`, not `dashboard.admin` | P2 | Blocker. Security |
| ADMIN-CV-API-CLIENT | Client and hooks for the customer-data endpoints, reusing the Auth0 token, never sending `X-Org-Id` cross-origin | P2 | Frontend plumbing |
| ADMIN-CV-LAYOUT-NAV | Admin customer-view routes, shared layout, and back links that return to the admin hub | P2 | `PageShell` hardcodes `/` |
| ADMIN-CV-HUB | Admin hub: org directory, org switcher, five nav cards | P2 | Screen |
| ADMIN-CV-BILLING | Billing Status screen clone | P2 | Screen |
| ADMIN-CV-USAGE | Usage Summary screen clone: usage bar, daily chart, per-metric table, 30 s poll | P2 | Screen |
| ADMIN-CV-QUOTA | Quota Status screen clone | P2 | Screen |
| ADMIN-CV-ENTITLEMENTS | Entitlements screen clone | P2 | Screen |
| ADMIN-CV-PARITY-TESTS | Contract and parity tests that pin the clone to the gateway's wire shapes and the Flutter behaviour | P2 | Test-only |
| ADMIN-CV-CORS-AUDIENCE | Verify CORS, issuer and audience pairing for the chosen read path in prod and dev | P3 | Applies now (A). Dev done 2026-10-04; prod waits on an authenticated GET to the new routes |

**ADMIN-CUSTOMER-VIEW.** *Goal:* staff get one place in this app to see what a customer sees on
`integritystudio.ai/dashboard`: org list, Billing, Usage, Quota and Entitlements, for **any** org.
Today that needs the customer's own login, or Supabase SQL that does not reproduce the customer's
rendering (plan projection, `effectivePlan`, entitlement overrides). *Source:* hub
`lib/pages/dashboard_page.dart`; pages `lib/pages/billing_status_page.dart`,
`usage_summary_page.dart`, `quota_status_page.dart`, `entitlements_page.dart`; shared layout
`lib/widgets/common/dashboard_scaffold.dart`; data layer `lib/services/dashboard_service.dart`;
models `lib/models/dashboard_models.dart`; backend `workers/api-gateway/src/index.ts`,
`src/routes/orgs.ts`, `src/routes/usage.ts`.
*Scope:* the five read screens, the org switcher, and the loading, error and empty states listed
below. *Non-goals:* any mutation. That means no `POST /billing-portal` (a portal session hands its
holder the customer's Stripe billing controls), no `POST /checkout-session`, no `/api-keys`, and
no impersonation or token minting for the customer. Also out: restyling the Flutter UI; changing
the customer app; replacing the existing `/admin` member-management page (`AdminPage.tsx`).
*Deliberate deviations:* every admin screen shows the org name and id in its header (the Flutter
Billing page shows neither), and the billing call-to-action renders as a read-only label.
*Parity checklist.*
- **Hub.** Title "Dashboard". Centred spinner while loading. Error card with the message and a
  "Try again" button. Empty state "No organizations found." With more than one org: an
  "Organization" label and a dropdown of org names. With exactly one: the name as plain text.
  Initial org is the preferred one if still listed, else the first (`pickActiveOrg`). Five cards
  in this order: Billing ("Plan, billing status, renewal date"), Usage ("Monthly usage summary by
  metric"), Quota ("Minute burst and monthly quota limits"), Entitlements ("Feature flags for your
  plan"), Observability ("View your traces, logs, metrics, and evaluations"). The page scrolls
  rather than clipping (IntegrityLandingPage 2f37ad0). Returning from a sub-page keeps the org
  selected (9c6a95d).
- **Billing.** Status badge: Active is success, Past Due is warning, everything else (inactive,
  canceled, unknown) is Inactive/error. Plan row. Renews on / Cancels on row. The two
  no-billing-account notes (contract-billed enterprise, and none yet). The CTA state
  (Manage Billing, Choose a plan, or none). A Refresh button.
- **Usage.** Period label. Units total with an optional quota bar. "Daily usage" bar chart summed
  across metrics. "Breakdown by metric" table. "No usage data for this period." A 30 s poll. A
  failed background poll keeps the data already on screen.
- **Quota.** Plan badge. Minute and Monthly rows showing `used / limit`, or `used (Unlimited)` when
  there is no limit, with progress bars coloured by threshold. "No quota data available."
- **Entitlements.** Feature/Value grid sorted by key. Booleans render as Enabled/Disabled badges,
  numbers as text, `null` as "N/A". "No entitlements found for this organization."
- **Every sub-page.** Back link to the admin hub, Refresh, and an error card with "Try again".
Children: every `ADMIN-CV-*` item above. Acceptance: all children done, and a staff member can
open any org from the hub and reach all four sub-pages and back without reloading.

**ADMIN-CV-GATEWAY-READ.** Every customer endpoint the Flutter app calls lives on api-gateway
(`https://api.integritystudio.dev`), and none of them can serve this feature as it stands. Three
reasons, all verified in `workers/api-gateway/src/index.ts`:
- **Membership only.** Access is membership-only: `preVerifyToken` (`src/lib/helpers.ts`, UA08)
  and each handler (`loadUserMemberships` in `orgs.ts`, `assertOrgAccess` in `usage.ts`) 403 any
  caller without an `active` `organization_memberships` row for that org. There is no staff bypass.
- **Metered reads.** Every `/v1/orgs/:id/*` request, reads included, runs
  `checkOrgRateLimit(orgId)` and `enforceOrgQuota`. That reserves one `requests` unit in the
  customer's quota Durable Object, and `recordMeteredRequest` writes a `usage_events` row that
  feeds `usage_buckets_daily` (`src/lib/usage-ledger.ts`). So an admin read would count against
  the customer's minute and monthly quota, and would show up in that customer's own Usage page.
  The Flutter Usage screen polls every 30 s, so one open admin tab adds about 120 rows an hour.
- **No directory.** `GET /v1/orgs` lists only the caller's own memberships, and nothing lists all orgs.
Options. **Decided 2026-10-04: (A).** The other two are kept for the record.
- **(A) Staff routes on api-gateway.** For example `GET /v1/admin/orgs` and
  `GET /v1/admin/orgs/:id/{billing-status,usage/summary,quota/status,entitlements}`, matched before
  the `/v1/orgs/:id` branch so they skip the membership pre-check, the per-org rate limit, quota
  and the ledger. The handlers reuse the existing data loaders with the membership check lifted
  out. Needs a staff source inside api-gateway: a second copy of `STAFF_USER_IDS` (it drifts from
  this worker's), an Auth0 role or permission claim, or a Supabase table. The browser calls the
  gateway directly, so CORS applies (see ADMIN-CV-CORS-AUDIENCE). Two repos change, and
  api-gateway deploys manually with `deploy:prd`.
- **(B) Proxy in this worker, reading Supabase itself.** New `/api/admin/customer/*` routes behind
  the staff gate that query Supabase `cfrbahzzklwrnmbtqojl` directly with the service-role key
  this worker already holds. Same-origin, and reuses the existing gate and `logAuditEvent`. It
  re-implements `buildEntitlementMap` (`workers/lib/entitlements.ts`), `effectivePlan`
  (`workers/lib/billing.ts`) and the usage and billing queries. That duplication is exactly how
  "what the customer sees" drifts. Quota lives in api-gateway's `QUOTA_DO`, so B cannot serve the
  Quota screen without a cross-script Durable Object binding or a gateway route.
- **(C) Hybrid.** This worker gates on staff and calls the gateway's unmetered admin routes from
  (A) over a Cloudflare service binding, authenticated by that binding rather than by a user
  token. Only one staff list (this worker's), same-origin for the browser, and the gateway keeps
  owning the response shapes. Both repos change. Both Workers appear to share the `alyshia-b38`
  account; confirm before relying on a service binding.
**What choosing (A) leaves open.**
- **Staff source inside api-gateway.** Choose one of: a second copy of `STAFF_USER_IDS` (it drifts from this worker's), an Auth0 role or permission claim, or a Supabase table. The gateway has to enforce it itself, because this app's `isStaff` check is presentation only (ADMIN-CV-STAFF-GATE).
- **Routes.** The new routes must be matched before the `/v1/orgs/:id` branch, so they skip membership, the per-org rate limit, quota and the ledger. They must stay `GET`, because CORS allows only `GET, POST, OPTIONS`.
- **Deploy.** api-gateway goes to production by hand with `deploy:prd`.
- **The browser calls the gateway cross-origin.** CORS and tenant pairing therefore apply (ADMIN-CV-CORS-AUDIENCE), and the client must not send `X-Org-Id` (ADMIN-CV-API-CLIENT).

Hard requirements, whichever option:
- Staff only (see ADMIN-CV-STAFF-GATE).
- No quota reservation, no `usage_events` row, and no per-org rate-limit consumption for the
  customer's org.
- Read-only.
- Response bodies byte-compatible with the customer routes (`{org_id, billing_status,
  current_plan, quota_version, role, has_billing_account}`, `{org_id, period_start, buckets[]}`,
  `{org_id, …quota status}`, `{org_id, entitlements}`), so parity holds by construction.
- A directory returning `id, name, slug, billing_status, current_plan` for every org.
- An `audit_log` row per org opened (not per poll) recording who viewed which org.
Acceptance:
- A staff token reads all five payloads for an org it is not a member of.
- A non-staff token (including an org owner) gets 403.
- The customer's `usage_events` row count and quota DO `minuteUsed`/`monthlyUsed` are unchanged
  across 10 admin reads (proved by a test on the gateway, or by reading the ledger before and
  after).

**ADMIN-CV-STAFF-GATE.** `AdminLink` and `AdminGuard` (`dashboard/src/App.tsx`) check
`session.permissions.includes('dashboard.admin')`. Under org scoping that permission is granted to
every customer org `owner`, `admin` and `billing_admin` (`DASHBOARD_ROLE_BY_MEMBERSHIP` and
`PERMISSIONS_BY_DASHBOARD_ROLE` in `dashboard/src/lib/org-rbac.ts`). Reusing that gate would show
every customer org owner the cross-org customer view. The only cross-org identity is `isStaff`:
`STAFF_USER_IDS` in `dashboard/wrangler.toml`, computed in the auth middleware in
`dashboard/worker/index.ts`, and exposed on `/api/me` and `useOrg().isStaff`. The worker already
applies this rule to the legacy global admin routes (`canUseGlobalAdmin`: under
`ORG_SCOPING_ENABLED=true` it returns `session.isStaff === true`). Fix:
- A `StaffGuard`, plus a hub entry point visible only to `isStaff`: an `AdminLink` variant, or a
  card on `/admin`.
- The server-side check in ADMIN-CV-GATEWAY-READ must enforce the same rule independently, since
  the client gate is presentation only.
- A pre-cutover or legacy session carries no `isStaff`. Treat that as not staff.
Acceptance:
- With `isStaff: false` and `permissions` including `dashboard.admin`, the entry point is hidden
  and the routes render Access Denied.
- With `isStaff: true`, both work.
- Covered by component tests.

**ADMIN-CV-API-CLIENT.** `useApiQuery` (`dashboard/src/hooks/useApiQuery.ts`) fetches through
`apiFetch` (`dashboard/src/lib/api-client.ts`), which adds `X-Org-Id` whenever an active org is
set. On a cross-origin call to api-gateway that header forces a preflight, and the live gateway
answers `Access-Control-Allow-Headers: Authorization, Content-Type` (probed 2026-09-29, and
`CORS_ALLOW_HEADERS` in `workers/api-gateway/src/index.ts`). The browser would therefore block
every call. It is also meaningless there: the viewed org travels in the path, and it is not the
admin's active org.
- Under option (A), add a gateway base URL (`VITE_…`, prod `https://api.integritystudio.dev`)
  and a fetch path that sends only `Authorization`. Under (B) or (C), the calls are same-origin
  `/api` calls and `apiFetch` can stay.
- Either way, reuse `useAuth().getAccessToken()`. The token already carries audience
  `https://api.integritystudio.dev`, the value in both `dashboard/wrangler.toml` and
  `workers/api-gateway/wrangler.toml`, on the same Auth0 tenant (prod `dev-68gg87ow4mg4kzyo`,
  dev `dev-njjmghdzm23uy0p7`). No second login.
- Hooks: `useAdminOrgDirectory`, `useAdminBillingStatus(orgId)`, `useAdminUsageSummary(orgId)`
  (with `refetchInterval` 30 000 ms), `useAdminQuotaStatus(orgId)`, `useAdminEntitlements(orgId)`.
- Zod schemas mirror the Dart parsers' defaults. Billing reads `current_plan` falling back to
  `plan_key`, and optional `plan_display_name`, `current_period_end` and `cancel_at_period_end`.
  Quota accepts the `{status: 'uninitialized'}` variant.
- Error messages match `DashboardService`: 401 "Authentication required. Please log in again.";
  403 "You don't have permission to manage billing for this organization."; 5xx after retries
  "Server error. Please try again."; timeout "Connection timed out. Please try again."; network
  "Network error. Please try again."; anything else "An unexpected error occurred." Retries stay
  at `useApiQuery`'s two, with none on 401.
- Reject an `orgId` containing `/?#%`, as the Dart service does.
Acceptance:
- No admin request sends `X-Org-Id` to a cross-origin host.
- Hook tests cover each schema's defaults and each error mapping.

**ADMIN-CV-LAYOUT-NAV.**
- Add routes `/admin/customers` (hub) and `/admin/customers/:orgId/{billing,usage,quota,entitlements}`
  to `dashboard/src/App.tsx`, with builders in `dashboard/src/lib/routes.ts`.
- The org id lives in the path, not in router state. That makes deep links and reloads work,
  which the Flutter app cannot do: its sub-routes redirect to `/login` when `state.extra` is
  missing.
- Back links: `PageShell` (`dashboard/src/components/PageShell.tsx`) hardcodes
  `<Link href="/">← Back to dashboard</Link>`, the same bug IntegrityLandingPage just fixed in
  9c6a95d, where sub-pages went home instead of to the hub. Give `PageShell` a `backHref` and
  `backLabel` (default `/`, "Back to dashboard", so existing pages are unchanged). Admin sub-pages
  pass `routes.adminCustomerHub(orgId)`, and the hub reselects that org, the equivalent of
  Flutter's `DashboardArgs.initialOrgId`. The hub itself goes back to `/admin`.
- Keep the Flutter scaffold's single centred column (Flutter uses max width 600). Style it with
  `theme.css` classes and no inline styles.
- Each route sits inside the existing `ErrorBoundary` + `RouteErrorFallback` pattern.
Acceptance:
- Every admin sub-page's back link lands on the hub with the same org selected.
- Existing `PageShell` callers render unchanged.
- A reload on `/admin/customers/<id>/usage` renders that org's usage.

**ADMIN-CV-HUB.**
*Data:* the directory from ADMIN-CV-GATEWAY-READ (`id, name, slug, billing_status, current_plan`).
It replaces `GET /v1/orgs` → `{organizations: [...]}`, which only lists the caller's own
memberships.
*UI:* the hub items in the epic's parity checklist.
- *Admin-only addition:* search or filter by name and slug once there are many orgs. Today the
  whole list goes into one dropdown, as in Flutter; filed as an open question, not built by default.
- *Org choice:* switching orgs is local page state, as in Flutter. It must **not** call
  `POST /api/org/switch`, which would persist the admin's own `default_organization_id`, nor
  `OrgContext.switchOrg`, which invalidates the whole query cache.
- *Observability card:* in Flutter it opens `https://integritystudio.dev`, which is this app.
  For admin, choose between linking to `/` in the viewed org (staff may set any `X-Org-Id`, but
  that persists through `switchOrg`) and omitting it. Open question.
*States:* loading, error with "Try again", and "No organizations found.".
*Acceptance:*
- Each state renders.
- More than one org shows a dropdown; exactly one shows the name.
- Selecting an org and opening a card navigates with that org id.
- Returning selects it again.
- A preferred org that no longer exists falls back to the first.
*Tests:* Vitest + Testing Library (`dashboard/src/__tests__/*.test.tsx`, jsdom, setup
`src/__tests__/setup.ts`), including a port of the four `pickActiveOrg` cases in
IntegrityLandingPage `test/pages/dashboard_page_test.dart`. Playwright
(`dashboard/e2e/*.spec.ts`): `e2e/fixtures.ts`'s `MOCK_ME_RESPONSE` has no `isStaff`, so it
needs a staff variant.
*Depends on:* ADMIN-CV-GATEWAY-READ, ADMIN-CV-STAFF-GATE, ADMIN-CV-API-CLIENT, ADMIN-CV-LAYOUT-NAV.

**ADMIN-CV-BILLING.**
*Data:* the billing-status payload `{org_id, billing_status, current_plan, quota_version, role,
has_billing_account}` (`handleOrgBillingStatus`, `workers/api-gateway/src/routes/orgs.ts`).
*UI (`billing_status_page.dart`):*
- Title "Billing Status", subtitle "Current plan and renewal information".
- Card title is `plan_display_name`, or "Plan" when it is empty.
- Status badge, as in the epic's checklist.
- Row "Plan: `current_plan`", or "—" when empty.
- Row "Renews on", or "Cancels on" when `cancel_at_period_end` is set, with the value formatted
  "Month D, YYYY" in local time, or "—".
- When `has_billing_account` is false, one note:
  - enterprise (`current_plan === 'enterprise'`): "This organization is billed by contract.
    Contact support to make changes."
  - otherwise: "No billing account yet. Choose a plan to set one up."
- Refresh button.
- The customer's CTA, shown as a read-only label: "Manage Billing" when `has_billing_account` is
  true, "Choose a plan" when it is false, nothing for enterprise.
- *Known gap, reproduce rather than fix here:* the endpoint returns no `plan_display_name`,
  `current_period_end` or `cancel_at_period_end`. So the customer always sees the title "Plan"
  and "Renews on: —". The admin clone parses those fields optionally, so it updates when the
  gateway adds them.
*States:* card-level loading, error card with "Try again", and data.
*Acceptance:*
- For each of `active`, `past_due`, `inactive`, `canceled` and an unknown value, the badge label
  and colour match.
- The enterprise, no-account and has-account variants each show the right note and CTA label.
- No request to `/billing-portal` or `/checkout-session` is ever made.
*Tests:* component tests over fixtures typed from the schema.
*Depends on:* ADMIN-CV-GATEWAY-READ, ADMIN-CV-API-CLIENT, ADMIN-CV-LAYOUT-NAV.

**ADMIN-CV-USAGE.**
*Data:* the usage payload `{org_id, period_start, buckets: [{organization_id, bucket_date,
metric_key, total_quantity, request_count, avg_latency_ms}]}` (`handleUsageSummary`,
`workers/api-gateway/src/routes/usage.ts`). The range is the current UTC month, from
`usage_buckets_daily`, ordered by `bucket_date` descending.
*UI (`usage_summary_page.dart`):*
- Title "Usage Summary", subtitle the org name, or "Current month usage breakdown".
- Card "Monthly Usage".
- Period label "Since `period_start`", or "Current period".
- Total: "`used` / `quota` units" when quota > 0, otherwise "`used` units". A progress bar shows
  only when quota > 0, coloured warning at a ratio ≥ 0.75 and danger at ≥ 0.90
  (`QuotaThresholds`).
- "Daily usage" bar chart (Recharts, already a dependency):
  - one bar per date, summing `total_quantity` across metrics (`aggregateUsageByDate`), dates
    ascending;
  - an x label on day 1 and every 5th day, and 4 horizontal grid lines;
  - when quota > 0: a dashed reference line at quota / 30, and each bar coloured by its ratio to
    that line.
- "Breakdown by metric" table:
  - columns Metric, Units, Requests;
  - `metric_key` converted from snake_case to Title Case;
  - rows sorted by units, descending.
- *Parity quirk:* the Flutter hub always passes `monthlyUnitsQuota: 0`
  (`dashboard_page.dart`), so the customer never sees the quota bar, the reference line, or bar
  colouring. The clone copies that by default. Whether admin should feed
  `entitlements.monthly_units` instead is an open question.
*States:*
- A spinner only on the first load. Background polls refresh silently.
- A failed poll keeps the current data. Only a first-load failure shows the error card.
- "No usage data for this period." when there is no summary. A summary with zero buckets shows
  "0 units" and no chart or table.
- A 30 s poll, plus a refetch on focus (Flutter refetches on app resume).
*Acceptance:*
- Unit tests for daily aggregation, per-metric totals and sort, and the day-label rule (including
  malformed dates).
- A test that a poll error after a success leaves the data on screen.
- Under ADMIN-CV-GATEWAY-READ's no-metering rule, polling adds no `usage_events` rows for the org.
*Depends on:* ADMIN-CV-GATEWAY-READ, ADMIN-CV-API-CLIENT, ADMIN-CV-LAYOUT-NAV.

**ADMIN-CV-QUOTA.**
*Data:* the quota payload. Either `{org_id, orgId, planKey, quotaVersion, minuteLimit,
monthlyLimit|null, minuteUsed, monthlyUsed, minuteWindowExpiresIn}`, or
`{org_id, status: 'uninitialized'}` when the Durable Object is unavailable. Source:
`handleQuotaStatus`, and `QuotaStatusResponseSchema` in `workers/lib/types/schemas.ts`.
*UI (`quota_status_page.dart`):*
- Title "Quota Status", subtitle the org name, or "Minute burst and monthly usage limits".
- Card "Quota Usage".
- Plan badge when `planKey` is set, with snake_case converted to Title Case.
- Row "Minute: `minuteUsed` / `minuteLimit`".
- Row "Monthly: `monthlyUsed` / `monthlyLimit`", or "`monthlyUsed` (Unlimited)" when the limit is
  `null`.
- A progress bar for any non-null limit, with the ratio clamped to 0–1, coloured by the
  0.75 / 0.90 thresholds. A limit of 0 draws an empty bar.
- `minuteWindowExpiresIn` is parsed but not displayed.
- "No quota data available." when there is no data.
- Refresh button.
- *Parity quirk:* Flutter parses the `uninitialized` body into defaults, so the customer sees
  "Minute: 0 / 0" and "Monthly: 0 (Unlimited)" with no badge. Reproduce it, or show an explicit
  "Quota not initialized" for admin. Open question.
*Acceptance:*
- Tests cover an initialized payload, a `null` monthly limit, bar colours at 0.74, 0.75, 0.89 and
  0.90, and the uninitialized payload.
- Reading quota status does not reserve a unit. `getQuotaStatus` reads the Durable Object's
  `/status`, but the gateway's `enforceOrgQuota` wrapper does reserve one; see
  ADMIN-CV-GATEWAY-READ.
*Depends on:* ADMIN-CV-GATEWAY-READ, ADMIN-CV-API-CLIENT, ADMIN-CV-LAYOUT-NAV.

**ADMIN-CV-ENTITLEMENTS.**
*Data:* the entitlements payload `{org_id, entitlements: Record<string, boolean | number | null>}`
(`handleOrgEntitlements`). The map is built by `buildEntitlementMap` in
`workers/lib/entitlements.ts`: `plans.features` booleans plus `monthly_units`,
`requests_per_minute` and `concurrent_jobs`, with per-org `entitlements` rows overriding them.
`null` means unlimited.
*UI (`entitlements_page.dart`):*
- Title "Entitlements", subtitle the org name, or "Feature flags and limits for your plan".
- Card "Feature Entitlements".
- Header row Feature / Value.
- Rows sorted by key, ascending, with keys converted from snake_case to Title Case.
- Booleans render as a badge: Enabled (success) or Disabled (grey). Numbers render as plain text.
  `null` renders as "N/A".
- "No entitlements found for this organization." when the map is empty.
- Refresh button.
- *Parity quirk:* "N/A" is what the customer sees for an unlimited limit. Keep it for parity; an
  admin-only tooltip ("unlimited") is optional.
*Acceptance:* tests cover each value type, sort order, key formatting, and the empty map.
*Depends on:* ADMIN-CV-GATEWAY-READ, ADMIN-CV-API-CLIENT, ADMIN-CV-LAYOUT-NAV.

**ADMIN-CV-PARITY-TESTS.** Parity has to be pinned, or it drifts from both ends at once.
- **Contract fixtures.** Keep one fixture per gateway payload. They are typed from the admin Zod
  schemas and checked against the gateway's own response types in IntegrityLandingPage
  (`handleOrgBillingStatus`, `handleUsageSummary`, `handleQuotaStatus`, `handleOrgEntitlements`,
  and `QuotaStatusResponseSchema`), so a renamed field fails here. The Dart side already carries
  contract tests for these shapes.
- **Behaviour table.** A single table-driven test file asserts every label, empty-state string,
  threshold and formatter named in the epic's parity checklist, with values copied from the Dart
  source and a comment citing the file and function.
- **Access.** A Playwright spec behind a staff `/api/me` mock walks hub → each sub-page → back,
  and a non-staff `dashboard.admin` mock gets Access Denied. Specs that assert on rendered numbers
  stub the gateway or proxy with `page.route`, so they never depend on live data (see
  `NO_DATA_SKIP_REASON` in `e2e/fixtures.ts` for why).
Acceptance: changing any string or threshold in the checklist fails a test.

**ADMIN-CV-CORS-AUDIENCE.** This applies now that option (A) is chosen (2026-10-04), because the
browser calls api-gateway directly. Checked live on 2026-10-04:
- **Production preflight passes.** `OPTIONS https://api.integritystudio.dev/v1/orgs` returns 204
  and echoes the caller's origin for both `https://integritystudio.dev` and
  `https://www.integritystudio.dev`. A GET with no token returns 401 carrying the same
  `Access-Control-Allow-Origin`, so a browser can read the error.
  - `Access-Control-Allow-Headers` is `Authorization, Content-Type`, so there is no `X-Org-Id`;
    see ADMIN-CV-API-CLIENT.
  - A disallowed origin is not refused outright. It gets the first default entry,
    `https://integritystudio.ai`, which browsers reject as a mismatch, so this is not a hole.
- **Production runs on the built-in defaults.** The open question here was whether production
  binds `ALLOWED_ORIGINS_JSON` or was deployed from an unpushed tree.
  - Commit e4aec20 (`workers/lib/http/cors.ts`, `DEFAULT_ALLOWED_ORIGINS`) is now on
    IntegrityLandingPage's `origin/main`.
  - `wrangler secret list --name api-gateway` shows no `ALLOWED_ORIGINS_JSON`, and the
    production `[vars]` do not set it, so the defaults apply.
  - The last production deploy was 2026-09-30T23:45Z.
- **Dev now admits this app.** Until 2026-10-04, `api-gateway-dev` allowed only
  `http://localhost:8080`, the Flutter app's dev origin.
  - It now also allows `http://localhost:5173` and
    `https://quality-metrics-api-dev.alyshia-b38.workers.dev` (IntegrityLandingPage 683f8503,
    deployed version `40585090`).
  - Each dev origin's preflight now echoes that origin.
- **Tenant pairing.**
  - Production: this app and api-gateway both use `dev-68gg87ow4mg4kzyo`, with audience
    `https://api.integritystudio.dev`.
  - Dev: both use `dev-njjmghdzm23uy0p7`, with the same audience.
  - Checked live in dev: an e2e test user's dev-tenant token, sent from the
    `quality-metrics-api-dev` origin, gets 200 from `api-gateway-dev` with a matching
    `Access-Control-Allow-Origin`. The same token gets 401 from production.
  - This app's local `.env` uses the production tenant. To run locally against the dev gateway,
    use Doppler `dev`'s `VITE_AUTH0_*` values.
- **New admin routes** inherit CORS from the outer `fetch` wrapper, and must stay `GET`.
Acceptance:
- For the chosen option, a preflight and a GET from each production origin succeed. The
  preflight is done. The authenticated GET is still to do: it waits on the admin routes, and it
  needs a real browser session, because the production SPA has no password grant to mint a
  token from a script.
- ✅ The dev pairing (this app's dev origins and dev tenant against `api-gateway-dev`) is
  documented above and works (2026-10-04).

### API keys

Filed 2026-09-30. Paths outside this repo are in IntegrityLandingPage (`~/code/is-public-sites/IntegrityLandingPage`).

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ADMIN-API-KEY-ROTATION | A UI on `AdminPage` that lets an admin rotate their own API keys, through a same-origin worker route | P2 | Reopened 2026-10-05; fixed by option (b), the worker calls the function as a service. Code done, nothing deployed |

**ADMIN-API-KEY-ROTATION.** Nobody can rotate an `obtk_` key without an operator today. The only
rotation done so far was by hand: insert an `api_keys` row, PUT its `apikey:<sha256>` record into
the obtool-api `AUTH` KV, then revoke the old row and DELETE its record. So a leaked key stays live
until someone with database and Cloudflare access acts. The backend half already exists:
`supabase/functions/api-keys-rotate` (rotates one of the caller's own active keys and returns the
new plaintext token once) and `api-keys-list`. No app calls `api-keys-rotate` today, so this UI
would be its first consumer; only the toolkit's e2e suite exercises it.

*Blockers, in `api-keys-rotate/index.ts`.* Fix these in IntegrityLandingPage before exposing the
function to users, or the UI hands them to everyone with a key:
1. **The new key can land in another org.** It takes its org from the caller's
   `organization_memberships … .limit(1)` (~84-92), an arbitrary membership, not the old key's
   `organization_id`, which the old-key select (~95-101) does not even read. A user in two orgs who
   rotates gets a key that ingests into, and reads from, the other tenant.
2. **A failed rotation leaves the user with no key.** The old row is revoked and its KV record
   deleted (~113-126) *before* the new key is inserted (~133-148); neither result is checked. If
   the insert fails, the response is 500 and the user has no working key. Create and sync the new
   key first, then revoke the old one.
3. **A failed KV write still reports success.** If the new record's PUT fails (~171-181), the
   response is 201 with a `warning`, the new key does not authenticate, and the old one is already
   gone. With item 2's order fixed, this should fail and leave the old key in place.
Also confirm that the function's `KV_NAMESPACE_ID` secret names the `AUTH` namespace. Doppler's
`KV_NAMESPACE_ID` holds the *dashboard* namespace, so copying it from there would break every
rotation silently.

*Decided 2026-09-30:*
- **Only admins rotate, by design.** The UI lives on `AdminPage`, behind `dashboard.admin`
  (`AdminGuard`, `App.tsx`). The function rotates only the caller's own keys, so rotating another
  member's key is out of scope.
- **A same-origin worker route** (e.g. `POST /api/admin/keys/:keyId/rotate`), not a call from the
  SPA. A direct call would be cross-origin, and the function's CORS allows only
  `authorization, x-client-info, apikey, content-type`, so `apiFetch` with an active org would fail
  the preflight on `X-Org-Id` (the ADMIN-CV-API-CLIENT trap). Through the worker the SPA uses
  `apiFetch` as usual (`useAdminFetch`).

*The route:*
- **Gate it on the server.** `AdminGuard` only hides the page. Use `orgAdminScope(c)`
  (`worker/index.ts`), which the member routes already use: `dashboard.admin` plus an active org,
  else 403. `dashboard.admin` is an org-scoped grant, so allow only keys whose `organization_id` is
  the active org. An admin of one org must not rotate their key in an org where they are only a
  member. Check this against `api_keys` with the service key before forwarding.
- **Call `api-keys-rotate` as a service.** *Superseded 2026-10-05; this bullet said to forward the
  user's bearer token, which Supabase cannot verify (see Reopened below).* The worker sends its
  service key and the verified user's id; it never forwards the user's token.
- **Audit it** with `logAuditEvent` (`key.rotate`, old and new key ids, never the token), as the
  member routes do.
- **Return the token in the response only.** The worker sets `no-store` on `/api/*` already; it must
  not log or cache the token.

*UI:*
- List the caller's active keys: prefix (`obtk_ab12cd34…`), name, tier and created date, plus last
  used if `api-keys-list` returns it.
- Rotate each key behind a confirm that says the old key stops working immediately (the function
  has no grace period) and names what to update, e.g. `OBTOOL_API_KEY` wherever the hooks read it.
- Show the new token exactly once, with a copy button. Keep it out of `localStorage` and out of the
  React Query cache: use a mutation's result, not a query, and drop it when the user leaves the page.
- Errors stay visible in the row. Since 099c7b9 the admin tables stay mounted across reloads.
- Styles come from `theme.css` classes, not inline `style`.

*Reopened 2026-10-05.* Marked done 2026-10-04 on code that passes its tests but cannot work in
production. The route step "first confirm that the Supabase gateway accepts this app's Auth0
token" was skipped, and it does not.
- **What landed.** IntegrityLandingPage 7f35b4f1 fixes all three blockers in `api-keys-rotate`.
  Dashboard 24d47cd adds `GET /api/admin/keys`, `POST /api/admin/keys/:keyId/rotate` (gated by
  `orgAdminScope`, checked against the active org, audited as `key.rotate`), the keys section on
  `AdminPage`, and tests.
- **Why it fails.** Read from the Supabase Management API on 2026-10-05, project
  `cfrbahzzklwrnmbtqojl` has **no third-party auth providers**, and the deployed `api-keys-rotate`
  has `verify_jwt: true`. The route forwards the user's Auth0 token, so Supabase's gateway rejects
  it before the function runs, and every rotation returns an error. The worker tests mock the
  function, so they cannot see this.
- **`verify_jwt = false` was not a fix on its own.** The old handler's `getJwtSub` base64-decoded
  the token's payload and trusted `sub` without checking a signature, so it relied entirely on the
  gateway's check. Turning that check off without changing the handler would have let anyone forge
  a token carrying another user's Auth0 id, revoke that user's keys and be handed a new one. The
  fix below turns it off only together with removing that path and requiring a service key.
- **Decided 2026-10-05: (b), the worker calls the function as a service.** Rejected: (a), enabling
  Auth0 as a Supabase third-party provider. That is project-wide, so Auth0 tokens would reach
  PostgREST and RLS, where today all access goes through the service key.
  - **Function** (IntegrityLandingPage, uncommitted): `api-keys-rotate` is split into
    `handler.ts` and `index.ts`, like `api-keys-create`.
    - It requires a service-level key on every request (the same Auth-admin capability check as
      `api-keys-create` and `api-keys-set-status`). It takes `{ keyId, userId }` and no longer
      reads any JWT.
    - `supabase/config.toml` sets `verify_jwt = false`, which Supabase documents for
      server-to-server calls with `sb_secret_` keys.
    - 21 tests in `supabase/tests/edge-functions/api-keys-rotate.test.ts`: the fake backend
      learned PostgREST and KV `DELETE`, and a mutation check confirmed the credential and
      rollback tests fail when those paths are broken.
  - **Worker** (this repo): the route sends `serviceRoleHeaders` (the `dashboard_worker`
    `sb_secret_` key) and `{ keyId, userId: appUserId }`. `admin-keys.test.ts` pins that the
    user's token is never forwarded.
  - **e2e** (observability-toolkit `services/e2e/api-key-auth.e2e.ts`): test 5 rotates through a
    `rotateKey` helper with `SUPABASE_PROVISIONING_KEY`, as `createKey` does. It will fail
    against dev until the dev function is redeployed.
  - Also fixed the two lint errors 24d47cd left. A rotate response with no token now shows an
    error instead of nothing (`RotateKeyResponseSchema`).
- **Still unchecked:** that the function's `KV_NAMESPACE_ID` secret names the `AUTH` namespace
  (see the blockers above).
- **To ship, in order:**
  1. Check `KV_NAMESPACE_ID` (above).
  2. Deploy `api-keys-rotate` to dev (`tumhmtshahktumhqqamk`, needs the CLI's keychain login; the
     Doppler `prd` token cannot reach dev) and run the toolkit's `api-key-auth` e2e under Doppler
     `dev`.
  3. Deploy it to production (`cfrbahzzklwrnmbtqojl`); the live version is 28, mid-September,
     which predates 7f35b4f1.
  4. Deploy the three dashboard Workers.
  5. Rotate a real key from `/admin` and check the acceptance bullets below.
- **Acceptance below is unmet.** In particular the first bullet: no rotation has succeeded
  against a real function.

Acceptance:
- A user rotates one of their keys. The new token authenticates against obtool-api
  (`GET /v1/traces` → 200) and the old one is refused (401).
- The new key belongs to the same org as the old one (blocker 1).
- The route answers 403 to a session without `dashboard.admin`, to one with no active org, and for
  a key outside the active org. A worker test pins all three.
- Each rotation writes one `key.rotate` audit row, with no token in it.
- A rotation that fails at any step leaves the old key working and shows an error (blockers 2-3).
- The token appears once and is not found in `localStorage` or the query cache afterwards.
- `AdminPage.test.tsx` covers success, refusal, network error and cancel, using new routes in its
  fake worker.

### Security

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ~~AUTH-NO-ORG-LEGACY-SESSION~~ | ~~A signed-in user with no org membership gets a legacy global session and reads bare-key (pre-tenancy) KV data~~ | ~~P1~~ | Done 2026-10-01 — commit 6579b2c. Pinned by `worker/__tests__/org-auth-no-membership.test.ts`; live once the three workers are redeployed |

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

### Tooling and config

Filed 2026-10-01. `npm run typecheck:scripts` fails today with three errors, from two causes. No workflow
runs it: CI builds without the parent's `dist/`, which `tsconfig.scripts.json` includes. So both causes are
visible only locally.

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| JUDGE-CLIENT-TEXTSTREAM | `scripts/judge-anthropic-client.ts` no longer type-checks against the parent's `@types/node` 26.6.3 | P3 | New 2026-10-01, from parent #101 |
| SCRIPTS-TYPECHECK-WINDOW | `src/lib/api-client.ts` uses `window`, which the scripts config cannot see | P4 | Since 2026-08-14 (`0e5f0c1`) |
| VITE-API-URL-DOPPLER | Doppler `integrity-studio` still holds `VITE_API_URL`, which this app no longer reads | P4 | (review) Blocked on tcad-scraper |

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

**VITE-API-URL-DOPPLER.** Since `e2d519b` (same-origin `/api` everywhere) this app reads no
`VITE_API_URL`. It was removed from the local `.env`, but left in Doppler `integrity-studio`.
- **Why it stayed.** tcad-scraper's production `deploy.yml` reads it from `prd`, falling back to
  `https://api.alephatx.info/api`. Deleting it would silently move that build to the fallback.
- **Unchecked.** The `dev_personal` and `stg` configs hold it too; their values were not checked.
- **Fix.** Give tcad-scraper a key of its own, or its own project, then delete `VITE_API_URL` from every
  `integrity-studio` config.

Acceptance: `doppler secrets get VITE_API_URL` fails in every `integrity-studio` config, and tcad-scraper's
production build still points at its API.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.8](changelog/3.0.8/CHANGELOG.md) (2026-08-28), which closed
`SCRIPTS-TSCONFIG-NUIA`.

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
