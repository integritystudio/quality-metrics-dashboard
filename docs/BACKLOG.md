# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

No open items.

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| SESSION-DETAIL-DRIFT | Session detail is computed twice, and the two copies disagree | P2 | Source: session 2026-10-06 scripts audit |

**SESSION-DETAIL-DRIFT.** `scripts/sync-to-kv.ts#computeSessionDetail` (the KV path, `:782`) and the dev API route
`src/api/routes/sessions.ts` (`:100-215`) extract the same fields from spans — tokens, tool/MCP counts, errors, git
commits (same regexes), code structure, file access, alerts, step scores — and have drifted:
- The route counts a span as errored only on `status.code === 'ERROR'` (`sessions.ts:166`, and the step score at `:220`);
  sync also accepts the numeric `OTEL_STATUS_ERROR_CODE`. Whether cloud spans carry the numeric form was not checked,
  so the undercount is unconfirmed (review).
- The route's per-agent accumulator has no rate-limit event count, truncated/empty output counts or durations.
- **Fix.** One shared span-extraction module (e.g. `src/api/session-detail.ts`) used by both; keep `computeSessionDetail`'s
  tests (`scripts/__tests__/sync-to-kv.test.ts`) and add route coverage for the numeric status code.

Acceptance: both paths import the same extractors; a span with a numeric error status counts as an error in both.

### Workflow page

No open items.

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
| SYNC-REDUNDANT-QUERIES | sync-to-kv re-queries data it already holds | P3 | Source: session 2026-10-06 scripts audit |
| PHASE6-LOCAL-RETIREMENT | Retire `--source=local` and the parity tools after the rollback release | P3 | Source: session 2026-10-06 scripts audit |
| UPLOAD-POST-SEND-DUP | upload-evaluations and post-evaluations duplicate the routing and send loop | P3 | Source: session 2026-10-06 scripts audit |
| SYNC-ORG-ENTRIES-SPLIT | `computeOrgEntries` is ~480 lines with repeated query and wrangler scaffolding | P4 | Source: session 2026-10-06 scripts audit |
| SYNC-PERIOD-MS-TYPING | `PERIOD_MS` typed `Record<string, number>` forces five undefined guards in sync | P4 | Source: session 2026-10-06 scripts audit |
| SCRIPTS-MAIN-GUARD | Four scripts use the fragile `endsWith` direct-run guard; sync and backtest parse flags at import | P4 | Source: session 2026-10-06 scripts audit |
| BACKTEST-DEGRADATION-ORPHAN | `backtest-degradation.ts` has no npm script and no test | P4 | Source: session 2026-10-06 scripts audit |
| JUDGE-BACKFILL-FLAG | Decide whether to keep judge-evaluations `--backfill` (review) | P4 | Source: session 2026-10-06 scripts audit |
| GENERATE-TOKEN-TREE-DUP | `generate-token-tree.sh` duplicates `scripts/repomix/token-tree.sh` | P4 | Source: session 2026-10-06 scripts audit |
| DEPLOY-SECRETS-DEV-WORKER | `deploy-secrets.sh` skips `quality-metrics-api-dev` (review) | P4 | Source: session 2026-10-06 scripts audit |
| CLI-ERROR-FLAG-SPELLING | CLI errors name a flag with a trailing `=` even when given as `--flag value` | P4 | Source: session 2026-10-06 scripts audit |

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

**SYNC-REDUNDANT-QUERIES.** Per org, `computeOrgEntries` (`scripts/sync-to-kv.ts:972`) issues ~20 cloud queries that
mostly overlap:
- With the default `--days=30`, the 30d period query (`:980`) and `allEvals` (`:1262`) read the same window and filter.
- Metric detail (`:1063`) runs two queries per metric (last 7d, prior 7d); both windows fall inside the 30d set, and the
  current week is already in `groupedByPeriod['7d']`.
- **Fix.** Query once over `MAX_DAYS`, then slice by period and metric in memory (~16 fewer queries per org). Re-check
  the `QUERY_LIMIT` truncation warnings, which would then fire on one read instead of several.

**PHASE6-LOCAL-RETIREMENT.** The cloud-read roadmap (`../../docs/roadmap/dashboard-cloud-read-migration.md:166`) keeps
`--source=local` for one release after the 2026-10-04 default flip, then deletes it. That release removes ~900 lines:
`derive-parity.ts`, `judge-parity.ts`, `trace-coverage.ts` (or keep it as a shipper-health check — decide),
`account-stamps.ts` (apart from what judge option A needs), derive's `loadLocalSpans`, and the judge's local discovery and
`_loadExistingKeys`, plus their tests. Do not start before the rollback window closes.

**UPLOAD-POST-SEND-DUP.** `upload-evaluations.ts` (`main`, `routeRecord` at `:492`) and `post-evaluations.ts` both run
route → batch per destination → resolve secret/base URL → webhook or keyed request → `postBatch` → inter-batch delay, and
each has its own `k=v` summary formatter. Export `resolveSendConfig()`, `destinationFor(route)` and `formatCounts()` from
upload (post already imports from it). Upload's fingerprint/`evaluationId` dedup is load-bearing — keep it untouched.

**SYNC-ORG-ENTRIES-SPLIT.** `computeOrgEntries` (`scripts/sync-to-kv.ts:972`) runs ~480 lines. Split into period
entries, metric detail, trends + degradation, and sessions + agents (with an `accumulateAgent()` for the block in the
session loop). The nanosecond window `BigInt(x.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT` is built 13 times and
query-then-warn-on-cap repeated 4 times (`nsRange()` / `queryEvalsWarnCap()`); `kvBulkPut` (`:360`) and `kvBulkDelete`
(`:414`) repeat the batch/temp-file/`execFileSync`/stderr scaffolding (`runWranglerBulk()`).

**SYNC-PERIOD-MS-TYPING.** `PERIOD_MS` in `src/lib/constants.ts` is `Record<string, number>`, so sync guards
`PERIOD_MS[...] === undefined` five times (`scripts/sync-to-kv.ts:469`, `:980`, `:1057`, `:1149`, `:1241`). Typing it
`Record<Period, number>` removes them but touches the app's constants, so it was left out of the scripts-only pass.

**SCRIPTS-MAIN-GUARD.** `backtest-degradation.ts:345`, `derive-evaluations.ts:790`, `judge-evaluations.ts:1819` and
`sync-to-kv.ts:1641` detect a direct run with `process.argv[1]?.endsWith(...)` instead of the
`pathToFileURL(process.argv[1]).href` form the other scripts use, and seven scripts repeat the same `.then`/`.catch`
exit handling — a shared `runIfMain()` would cover both. `sync-to-kv.ts` and `backtest-degradation.ts` also parse their
flags (and can `process.exit(1)` via `exitOnCliArgError`) at import time; safe under vitest today, since vitest's argv
carries none of their flags, but fragile.

**BACKTEST-DEGRADATION-ORPHAN.** `scripts/backtest-degradation.ts` (~350 lines) is in no `package.json` script, has no
test, is not referenced from dashboard docs, and has had only maintenance commits since 2026-08-17. Retire it, or add an
npm script, a test and a direct-run guard.

**JUDGE-BACKFILL-FLAG.** `judge-evaluations --backfill` (`runBackfill`, plus `discoverSessionsFromTraces`) writes
seeded, synthetic `trace-backfill` scores — the kind of output `populate` refuses to produce without an explicit
`--seed`. It is documented nowhere and nothing invokes it; its tests do touch it. Keep (and document) or remove: a
product decision, not a refactor.

**GENERATE-TOKEN-TREE-DUP.** `scripts/generate-token-tree.sh` (used by `npm run filetree`) and
`scripts/repomix/token-tree.sh` both run `repomix --token-count-tree`, writing `docs/repomix/token-count-tree.txt` and
`docs/repomix/token-tree.txt`. Point `filetree` at the repomix script, adjust `update-readme-tree.sh` for its header line,
then delete the duplicate.

**DEPLOY-SECRETS-DEV-WORKER.** `scripts/deploy-secrets.sh` (`npm run deploy:secrets`) sets secrets on the two production
Workers only. The dev Worker has its own Supabase project and Auth0 tenant, so the omission may be deliberate; confirm and
note it in the script, or add a dev invocation under `--config dev`.

**CLI-ERROR-FLAG-SPELLING.** Flags declared through the `--flag=` prefix constants (`--days=`, `--judge-days=`,
`--post-days=`) are named that way in `positiveIntArg` errors, e.g. `--judge-days= must be a positive integer` for
`--judge-days 0`. `pipeline-stages.test.ts` and `derive-evaluations.test.ts` pin the current text. Strip the `=` when
labelling (cli-args has `optionName`) and update those tests.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.9](changelog/3.0.9/CHANGELOG.md) (2026-10-05).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
