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

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.8](changelog/3.0.8/CHANGELOG.md) (2026-08-28), which closed
`SCRIPTS-TSCONFIG-NUIA`.

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
