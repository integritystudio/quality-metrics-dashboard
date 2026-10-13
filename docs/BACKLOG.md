# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| KV-BULK-204-THROWS | A real HTTP 204 from the KV bulk API is counted as a failure | P2 | ✅ Done 2026-10-12 |
| KV-BULK-SDK-RETRIES-DAILY-LIMIT | The Cloudflare SDK retries the 10048 daily-limit response twice before `kvBulkPut` sees it | P4 | (review) Source: session 2026-10-12, PR #24 |
| KV-BULK-204-END-TO-END-TEST | No test drives the real SDK, `kv204Fetch` and `kvBulkPut` together on a 204 | P3 | Source: review of `ad4f290` (medium) |
| KV-BULK-TRANSPORT-TEST-GAPS | `kv-bulk-transport.test.ts` uses GET only and never asserts header pass-through | P4 | Source: review of `ad4f290` (low) |
| KV-BULK-204-LOG-AMBIGUITY | A converted 204 and a genuine `{"result":null}` body log the same line | P4 | Source: review of `ad4f290` (low) |
| KV-BULK-SDK-FETCH-ALIAS | `kv204Fetch` is typed `typeof http1Fetch` rather than a named `SdkFetch` type | P4 | Source: review of `ad4f290` (low) |
| KV-BULK-204-DONE-NOTE-STALE | The KV-BULK-204-THROWS Done note describes the superseded `TypeError` catch, not `kv204Fetch` | P4 | (review) Source: `c11a54b` superseded by `ad4f290` |

**KV-BULK-204-THROWS.** *Done 2026-10-12.* Caught `TypeError` in both `kvBulkPut` and `kvBulkDelete`
catch blocks — SDK 7.3.0 calls `_thenUnwrap((obj) => obj.result)` on the parsed body; HTTP 204 parses
as `null`, so `.result` throws `TypeError`. `kvBulkPut` now credits all batch keys and warns; `kvBulkDelete`
silently treats the batch as deleted. Fixed the incorrect comment that attributed the `null` result path
to HTTP 204 (it actually comes from a `{"result": null}` body). Pinned by two new `kv-bulk.test.ts` cases
(one per function) that mock the SDK to throw the exact `TypeError` the real SDK emits.

**KV-BULK-SDK-RETRIES-DAILY-LIMIT.** The client is built as `new Cloudflare({ fetch: http1Fetch })`
(`scripts/sync-to-kv.ts:122`) with the default `maxRetries: 2`. So a 10048 daily-limit 429 is retried
twice with backoff, though it cannot succeed until the next day. Each connection-failure test in
`kv-bulk.test.ts` also takes ~1.5 s of real backoff. Decide whether to pass `maxRetries: 0` and let
`populate`'s own network retry own the policy.

**KV-BULK-204-END-TO-END-TEST.** `kv-bulk-transport.test.ts` pins `kv204Fetch` against a loopback
server, and `kv-bulk.test.ts` checks that the client is built with it, but no test sends a 204 through
`new Cloudflare({ fetch: kv204Fetch })` into `kvBulkPut`/`kvBulkDelete`. An SDK upgrade that changes
how it unwraps a 200 `{"result":null}` body would pass both files while 204s fail again. Serve the
bulk endpoints from a `node:http` server with `CLOUDFLARE_BASE_URL` set and assert every key is
credited. -- `scripts/sync-to-kv.ts:130`

**KV-BULK-TRANSPORT-TEST-GAPS.** The transport tests issue GET requests only, while production sends
`PUT …/bulk` and `POST …/bulk/delete` with bodies, and none asserts that the original response
headers survive the 204 rewrite or the non-204 pass-through. -- `scripts/__tests__/kv-bulk-transport.test.ts:39`

**KV-BULK-204-LOG-AMBIGUITY.** After the rewrite, the `result == null` branch in `kvBulkPut` cannot
tell a real 204 from a 200 with a null `result`, so a run log does not show which Cloudflare sent.
Log the original status in `kv204Fetch` or tag the synthetic body if the distinction matters.
-- `scripts/sync-to-kv.ts:398`

**KV-BULK-SDK-FETCH-ALIAS.** `kv204Fetch` borrows its signature as `typeof http1Fetch`; a named
`SdkFetch` type would state the contract (the fetch the Cloudflare client accepts) instead of tying it
to a sibling implementation. -- `scripts/sync-to-kv.ts:130`

**KV-BULK-204-DONE-NOTE-STALE.** The KV-BULK-204-THROWS paragraph above records the first fix
(`c11a54b`: catching `TypeError` in both catch blocks, tests that mock the SDK). Review rejected that
as too broad and `ad4f290` replaced it with the `kv204Fetch` transport rewrite and a mock-free
loopback test. Rewrite the Done note to match what shipped.

### Workflow page

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| WORKFLOW-GRAPH-ZERO-POSITION | A node ELK returns without x/y is drawn at (0,0) | P3 | Source: session 2026-10-12, PR #19 (Unit 6) |

**WORKFLOW-GRAPH-ZERO-POSITION.** `WorkflowGraph.tsx:263/271` default a missing ELK coordinate to 0,
so a broken layout renders as nodes stacked at the origin instead of failing visibly. A related test
gap: `WorkflowGraph.test.tsx` checks only that siblings have different x, not that they don't overlap,
because `NODE_WIDTH` is not exported. Acceptance: a missing coordinate is surfaced (logged or rejected),
and a sibling non-overlap test uses the exported node width.

### API client

No open items.

### Admin customer view

No open items.

### API keys

No open items.

### Security

No open items.

### Tooling and config

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| VITE-API-URL-DOPPLER | Doppler `integrity-studio` still holds `VITE_API_URL`, which this app no longer reads | P4 | ⛔ Won't Do 2026-10-05 — the value is read by a separate repo (tcad-scraper), so it is not this app's to remove |
| PHASE6-LOCAL-RETIREMENT | Retire `--source=local` and the parity tools after the rollback release | P3 | ✅ Done 2026-10-09, ahead of the rollback-release gate at the owner's request; Source: session 2026-10-06 scripts audit |
| WORKER-TESTS-NOT-IN-CI | `worker/__tests__` (now real JWT and KV checks) still run only locally | P3 | (review) Source: session 2026-10-12, PR #25 (Unit 1) |
| TYPECHECK-SCRIPTS-HTTP1-FETCH | `npm run typecheck:scripts` fails in the parent's `src/lib/core/http1-fetch.ts(38,3)` | P3 | Source: session 2026-10-12, reported by Units 2 and 3 |
| PARITY-EVAL-WINDOW-GAP | No parity test catches a dropped `startDate` in `loadEvaluationsByMetric` | P3 | Source: session 2026-10-12, PR #23 (Unit 2) mutation check |
| SUITE-FLAKES-ON-PARENT-REBUILD | Test files fail to load while the parent `dist/` is being rebuilt | P3 | (review) Source: session 2026-10-12, Units 3 and 4 and the post-batch full run |
| PAGE-TEST-HARNESS-MERGE | Two memory-router page harnesses landed side by side | P4 | Source: session 2026-10-12, PRs #21 and #22 |
| STALE-TEST-DOUBLE-COMMENTS | Comments still describe test doubles the batch removed | P4 | Source: session 2026-10-12, Units 1 and 7, review of `c07bad6` |
| TEST-FIXTURE-DUPLICATES | Fixtures and helpers duplicated across test files | P4 | Source: session 2026-10-12, Units 3 and 7 |

**VITE-API-URL-DOPPLER.** Since `e2d519b` (same-origin `/api` everywhere) this app reads no
`VITE_API_URL`. It was removed from the local `.env`, but left in Doppler `integrity-studio`.
- **Why it stayed.** tcad-scraper's production `deploy.yml` reads it from `prd`, falling back to
  `https://api.alephatx.info/api`. Deleting it would silently move that build to the fallback.
- **Unchecked.** The `dev_personal` and `stg` configs hold it too; their values were not checked.
- **Fix.** Give tcad-scraper a key of its own, or its own project, then delete `VITE_API_URL` from every
  `integrity-studio` config.

Acceptance: `doppler secrets get VITE_API_URL` fails in every `integrity-studio` config, and tcad-scraper's
production build still points at its API.
*Won't Do, 2026-10-05.* tcad-scraper's `deploy.yml` reads the `prd` value, so the key is that repo's
dependency and is left in place. `stg` no longer holds it; `prd` holds `https://api.alephatx.info/api`.

**PHASE6-LOCAL-RETIREMENT.** *Done 2026-10-09.* Removed: `--source`, `--judge-source` and `--derive-source` (all now fail), derive's `loadLocalSpans`, the judge's local discovery and `_loadExistingKeys`, `derive-parity.ts`, `judge-parity.ts`, their tests and the two `:parity` npm scripts. Kept: `trace-coverage.ts` (decided: it measures shipper loss, not the rollback), `account-stamps.ts` (upload's account join and `anchorTurns` still use it) and `_discoverTranscripts` (judge-agreement and judge-quality-eval read it). The gate notes below are the record of what was checked. Original scope: The cloud-read roadmap (`../../docs/roadmap/dashboard-cloud-read-migration.md:166`) keeps
`--source=local` for one release after the 2026-10-04 default flip, then deletes it. That release removes ~900 lines:
`derive-parity.ts`, `judge-parity.ts`, `trace-coverage.ts` (or keep it as a shipper-health check — decide),
`account-stamps.ts` (apart from what judge option A needs), derive's `loadLocalSpans`, and the judge's local discovery and
`_loadExistingKeys`, plus their tests. Do not start before the rollback window closes.
- **Gate status, 2026-10-07.**
  - **Rollback release: not yet.** The flip shipped in the parent's v3.1.26 migration (2026-10-04), and the next
    release, 4.0.0, is still in progress.
  - **Exit check 2: passed.** Window 2026-09-30 to 10-06, read via `/v1/evaluations?evaluator=` per
    `OBTOOL_API_KEY*` under Doppler `prd`, compared with non-canary local records by event time:

    | Producer | D1 (`OBTOOL_API_KEY` + `_ALYSHIA_LEDLIE` + `_INVENTORY_AI`) | Local |
    |---|---|---|
    | `dashboard:judge-consolidated` | 686 + 3,346 + 174 = 4,206 | 4,206 |
    | `hook:stop-quality-evaluation` | 79 + 240 + 48 = 367 | 367 |
    | `hook:stop-session-summary` | 16 + 103 + 10 = 129 | 129 |
    | `survival-fitness` | 17 + 0 + 0 = 17 | 17 |
    | derive (`rule`) | 15,405 + 20,854 + 501 | no file since Phase 6 |

  - **Exit check 1: passed, 2026-10-09.** Run against `prd` from an empty `TELEMETRY_DIR` with the scheduled run's
    flags (`--limit 100 --batch`); the judge ran under option A, since option B (Phase 5) is undecided. derive posted
    22,314 records, the judge 704 (100 turns, $0.98 at batch rate), upload sent 0 (`skipped[too-old=704]`: the judge's
    records carry turn time, so the 36 h guard drops them, as the roadmap says), sync wrote 310 keys, exit 0.
    All 704 judge rows were in D1 42 min after the post (`dashboard:judge-consolidated` 344 → 902 and 2,520 → 2,666
    per key; judged turns 433 → 533), 146 of them at 27 min: each 100-record POST is one R2 object and the flush
    drains 100 objects per signal per 5 min, so a run's ~230 derive objects clear before the judge's 8.
    - **Side effect.** derive wrote a fresh `.calibration-state.json` from its 7-day window, without
      `handoff_correctness` and `task_completion` (the host's file carries them from earlier runs), and sync published
      it as `meta:calibration`. Reverted the same hour with `npm run sync` from the host's dir. An empty-dir machine
      publishes a narrower calibration than the host.
    - **Found on the way.** `LLM_JUDGE_ANTHROPIC_KEY` in Doppler `prd` returns `401 invalid x-api-key`: the 2026-10-08
      07:11 scheduled run judged fine, the 18:00 run and every one since exit 3 with `NO SCORES PRODUCED`.
      `ANTHROPIC_API_KEY` in the same config still works, and the check's judge ran with it. Rotate the judge key.
  - **JUDGE-BACKFILL-FLAG: resolved, 2026-10-09.** `--backfill` was removed, so it no longer holds `_loadExistingKeys`
    or `account-stamps.ts` in place. The `backfill` cohort and `trace-backfill` evaluator type stay readable for
    rows already written.

**WORKER-TESTS-NOT-IN-CI.** `ci.yml` and `deploy.yml` run `npm test src/`, so `worker/__tests__` never runs
in CI. Since PR #25 those files verify real RS256 tokens: a wrong `jwtVerify` audience fails 86 of them,
which passed before. Leaving them out means a worker auth regression can ship green. Acceptance: CI runs
`worker/__tests__`, or this note records why it can't.

**TYPECHECK-SCRIPTS-HTTP1-FETCH.** An undici `Response` type mismatch at `../src/lib/core/http1-fetch.ts(38,3)`
reds `typecheck:scripts` with no dashboard file changed. The file lives in the parent repo; fix it there or
narrow the scripts program's view of it.

**PARITY-EVAL-WINDOW-GAP.** Dropping `startDate` from `loadEvaluationsByMetric` in `src/api/data-loader.ts`
passed every parity test before and after PR #23. The fixture data has no evaluation that falls inside one
window and outside another. Add one, using the fixture server's opt-in `dateWindow`.

**SUITE-FLAKES-ON-PARENT-REBUILD.** While a parent `npm run build` rewrote `../dist`, runs failed with
`Cannot read properties of undefined (reading 'AGENT_NAME')` (13 script test files) and
`Cannot find module '@parent/...'`. One post-batch `npm test` failed 5 worker test files at load. Each
passed on rerun. The suspected cause is `parentDistStub` stubbing `@parent` while `dist/` is missing,
and that stub being cached in `node_modules/.vitest-cache`. Unconfirmed. `npx vitest --clearCache` is the
reset.

**PAGE-TEST-HARNESS-MERGE.** `src/__tests__/support/memory-router.tsx` (`makeRoutedQueryWrapper`, PR #21) and
`src/__tests__/support/page-harness.tsx` (`renderPage`, PR #22) both wrap a wouter `memoryLocation` around
`makeQueryWrapper`. Fold them into one once both land. Since `c07bad6`, error-path tests in those PRs can
use a 500 again instead of the 401 they chose to dodge retry backoff.

**STALE-TEST-DOUBLE-COMMENTS.**
- `src/__tests__/support/query-harness.tsx` says `OrgProvider` is deliberately absent, but PR #20 and
  `AdminCustomerPages.test.tsx` both render it. Its `retry` note names only `useApiQuery` and the admin
  hooks, though `useCalibration`, `useDashboard`, `useTrace` and `useSessionDetail` also override `retry`.
- The `isTokenRejection` comment in `worker/index.ts` still says it is lazy for tests that mock `jose`;
  none do after PR #25.

**TEST-FIXTURE-DUPLICATES.**
- `org-switcher.test.tsx` (PR #20) repeats the org fixtures in `org-switch.test.tsx`.
- `auth-context-refresh.test.tsx` keeps `'obs:login_recorded'` as a literal because the key is private
  to `AuthContext`.
- `scripts/__tests__/judge-anthropic-client.test.ts` keeps its own loopback server beside the new
  `scripts/__tests__/support/recording-server.ts` (PR #24).

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.11](changelog/3.0.11/CHANGELOG.md) (2026-10-09).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
