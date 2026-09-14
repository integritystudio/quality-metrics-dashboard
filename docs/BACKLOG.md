# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| ROUTE-TESTS-MOCK-FREE | Exercise API routes against a local HTTP fixture instead of `vi.mock` | P3 | 13 files under `src/__tests__/api-*.test.ts`, 41 `vi.mock` calls. 22 of them are two modules: `../api/data-loader.js` (11) and `../api/parent/error-sanitizer.js` (11). |

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

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.8](changelog/3.0.8/CHANGELOG.md) (2026-08-28), which closed
`SCRIPTS-TSCONFIG-NUIA`.

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
