# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| SYNC-ORG-ENTRIES-UNTESTED | sync-to-kv's per-org aggregation has no test; the single-read slicing landed unguarded | P3 | ✅ Done 2026-10-07 — `scripts/__tests__/sync-org-entries.test.ts` |

**SYNC-ORG-ENTRIES-UNTESTED.** `computeOrgEntries` (`scripts/sync-to-kv.ts:959`) is not exported, so none of
`scripts/__tests__/sync-to-kv.test.ts` reaches it. `5174c29` replaced its ~22 reads per org with one read sliced in
memory by `evalsBetween` (`:983`). The only check was a live dry-run comparison against production: 4,945 of 4,993
entries byte-identical, with the rest explained by a wall-clock timestamp and spans arriving between runs. That check is
not repeatable. Untested:
- `evalsBetween`'s day-aligned bounds (`queriedDateWindow`): a row at the start-day midnight is in, a row at the next
  midnight after the end day is out. The previous-week slice overlaps the current week by part of a day, as the old
  separate reads did.
- Truncation: a read of `QUERY_LIMIT + 1` rows sets `evaluationsTruncated` and `CAP-HIT`, and the 24h/7d slices keep
  the newest rows.
- Metric-detail names match exactly (the old server reads matched case-insensitive substrings).
- `computeTimespan` (`:565`): no assertion on `timespan` anywhere, though `computeSessionDetail` is exported and tested.
- Agent-session eviction (`:1320`): the oldest dated session goes first, the first one on ties, and the last slot goes
  when no session has a date.

**Fix.** Export `computeOrgEntries` (or the per-concern pieces from SYNC-ORG-ENTRIES-SPLIT) and drive it with a fake
`CloudBackend` whose `queryEvaluations`/`queryTraces` return fixed rows. Pull the eviction out into a small exported
function.

Acceptance: each bullet above has a test that fails if the behaviour changes.

*Done, 2026-10-07.* `computeOrgEntries` is exported and takes an `OrgReadBackend` (the two reads it makes), and the
eviction is `addRecentSession`. `sync-org-entries.test.ts` covers every bullet with a fake backend that returns rows
newest first and honours `limit`. Each of 12 seeded defects (bounds, rounding, the probe row, truncation, name
matching, the week boundaries, eviction, timespan rounding) failed at least one test. The overlap turned out to be
the whole of day `now − 7d`, not part of it (METRIC-WEEK-OVERLAP).

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| METRIC-WEEK-OVERLAP | Metric detail's current and previous week share a day, so the trend baseline is muted | P3 | Source: review of `5174c29`, 2026-10-07 |
| SYNC-DASHBOARD-TIMESTAMP-WRITES | A per-run timestamp makes 24 `dashboard:*` keys "changed" on every sync | P3 | Source: sync dry-run comparison, 2026-10-07 |
| KV-VALUE-NOT-JSON-UNGUARDED | Nothing checks that a KV value is JSON before it goes into the envelope | P4 | Source: review of `5174c29`, 2026-10-07 |

**METRIC-WEEK-OVERLAP.** The `metric:<name>` detail compares the last week with the one before it (`currentWeek` /
`previousWeek`, `scripts/sync-to-kv.ts:1051-1052`). The server rounds both bounds of a window to whole UTC days
(`queriedDateWindow`), and `evalsBetween` reproduces that rounding:
- current = `[dayStart(now − 7d), nextMidnight(now))`; previous = `[dayStart(now − 14d), nextMidnight(now − 7d))`.
- Both span 8 calendar days, and both contain the whole of day `now − 7d`. Example: with `now = 2026-10-08T01:08Z`, both
  windows include all of Oct 1.
- That day's evaluations feed both the card's current values and its `previousValues` baseline, which pulls the
  week-over-week change toward zero.
- **Pre-existing.** The separate server reads `5174c29` replaced had the same overlap, which is why the dry-run output
  matched byte for byte.

**Fix.** Give `evalsBetween` an exclusive end at a day start, and end the previous week at `dayStart(now − 7d)`. Decide
whether the current week should also drop to 7 whole days. The `metric:*` values will shift, so note the change where
the trend is read.

Acceptance: no evaluation counts in both windows, and a test pins the boundary day to exactly one of them. Flip
`counts the boundary day in both weeks` in `scripts/__tests__/sync-org-entries.test.ts`, which pins the overlap today.

**SYNC-DASHBOARD-TIMESTAMP-WRITES.** `computeDashboardSummary` stamps `timestamp: new Date().toISOString()`
(`../../src/lib/quality/quality-metrics.ts:948`, parent repo), and the auditor role view copies it
(`../../src/lib/quality/quality-views.ts:253`). `filterChanged` (`scripts/sync-to-kv.ts:359`) hashes the whole value, so
`dashboard:<period>` and `dashboard:<period>:auditor` (`:1001`, `:1005`) differ on every run even when no data changed.
- 2 keys × 3 periods × (each org + the legacy bare keys) = 24 writes per run with the current 3 orgs. They are
  high-priority keys, so they come out of the 450-write budget ahead of traces.
- Measured: two dry-runs on the same data, 40 s apart, differed on exactly these 24 keys (plus span-driven keys).
- **Fix options.** Pass the sync's `now` into `computeDashboardSummary` so the stamp is the data window's end, not the
  wall clock. Or leave the stamp out of the change hash, as `meta:syncCoverage` already does for `lastChecked`.

Acceptance: a no-op sync (no new evaluations) leaves every `dashboard:*` key unchanged, and the auditor view still
carries a timestamp.

**KV-VALUE-NOT-JSON-UNGUARDED.** `kvBulkPut` builds the version envelope by splicing the stored value in as text
(`scripts/sync-to-kv.ts:377`). Before `5174c29` it called `JSON.parse` on the value first, which was the only check that
the value was JSON. `toKVValue` (`:207`) is typed to return `string`, but `JSON.stringify(undefined)` returns
`undefined`, so `toKVValue(undefined)` would write `{"v":1,"data":undefined}` to KV without an error. No current caller
passes `undefined`.

**Fix.** In `toKVValue`, throw when `JSON.stringify` returns a non-string.

Acceptance: `toKVValue(undefined)` throws, and a test covers it.

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
| SYNC-REDUNDANT-QUERIES | sync-to-kv re-queries data it already holds | P3 | ✅ Done 2026-10-07 — `5174c29` |
| SYNC-KV-REST-API | Write KV through the Cloudflare API instead of spawning `npx wrangler` | P3 | ✅ Done 2026-10-07 — commit `3873812` |
| PHASE6-LOCAL-RETIREMENT | Retire `--source=local` and the parity tools after the rollback release | P3 | Source: session 2026-10-06 scripts audit |
| SYNC-ORG-ENTRIES-SPLIT | `computeOrgEntries` is ~480 lines with repeated query and wrangler scaffolding | P4 | Source: session 2026-10-06 scripts audit |
| JUDGE-BACKFILL-FLAG | Decide whether to keep judge-evaluations `--backfill` (review) | P4 | Source: session 2026-10-06 scripts audit |
| DEPLOY-SECRETS-DEV-WORKER | `deploy-secrets.sh` skips `quality-metrics-api-dev` (review) | P4 | Source: session 2026-10-06 scripts audit |

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

*Done, 2026-10-07 (`5174c29`).* One read per org over the longer of `--days` and two weeks, sliced with the server's
day-aligned bounds (`queriedDateWindow`). Truncation now applies to the shared read, and metric detail matches names
exactly. Tests are SYNC-ORG-ENTRIES-UNTESTED.

**SYNC-KV-REST-API.** `kvBulkPut` and `kvBulkDelete` (`scripts/sync-to-kv.ts:363`, `:417`) write each batch to a temp
file and run `execFileSync('npx', ['wrangler', 'kv', 'bulk', …])`. Each batch pays a `npx wrangler` start (seconds), and
failures are found by matching stderr text (`KV_WRITE_LIMIT_MARKERS`, `'code: 10048'`). `KV_BATCH_SIZE` was cut from
9,500 to 5,000 to dodge 502s, because nothing retries.
- **Adopt `cloudflare`** (the official SDK, devDependency, scripts only, so the Worker bundle is unaffected). It calls
  the KV bulk write/delete endpoints directly, with typed error codes and built-in retry with backoff on 429/5xx. No
  temp files. Confirm the SDK's bulk method names on install.
- **Adopt `smol-toml`** with it, and only with it. The SDK needs `account_id` (`wrangler.toml:4`) as well as the
  namespace id, and a parser replaces `resolveNamespaceId`'s regex (`:95`) for both fields. On its own it is not worth
  adding.
- **Auth.** wrangler already uses `CLOUDFLARE_API_TOKEN` (the KV-scoped token in Doppler `prd`), so no new credential.

Acceptance: `npm run sync` writes and prunes KV without spawning wrangler. A free-tier limit hit is detected by error
code, not by stderr text. A transient 5xx is retried rather than failing the run.

**PHASE6-LOCAL-RETIREMENT.** The cloud-read roadmap (`../../docs/roadmap/dashboard-cloud-read-migration.md:166`) keeps
`--source=local` for one release after the 2026-10-04 default flip, then deletes it. That release removes ~900 lines:
`derive-parity.ts`, `judge-parity.ts`, `trace-coverage.ts` (or keep it as a shipper-health check — decide),
`account-stamps.ts` (apart from what judge option A needs), derive's `loadLocalSpans`, and the judge's local discovery and
`_loadExistingKeys`, plus their tests. Do not start before the rollback window closes.

**SYNC-ORG-ENTRIES-SPLIT.** `computeOrgEntries` (`scripts/sync-to-kv.ts:959`) runs ~430 lines. Split into period
entries, metric detail, trends + degradation, and sessions + agents (with an `accumulateAgent()` for the block in the
session loop at `:1275`). Updated 2026-10-07 after `5174c29`, which read evaluations once per org:
- **Gone.** The repeated query-then-warn-on-cap for evaluations (`queryEvalsWarnCap()`): there is one read now.
- **Partly done.** `msToNs()` (`:254`) exists, but three sites still build the nanosecond window by hand
  (`BigInt(x.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT`). They are `discoverOrgIds` (`:878`),
  `computeCodeQuality` (`:936`) and the span read (`:1227`).
- **Unchanged.** `kvBulkPut` (`:363`) and `kvBulkDelete` (`:417`) repeat the batch/temp-file/`execFileSync`/stderr
  scaffolding (`runWranglerBulk()`). SYNC-KV-REST-API would remove that scaffolding rather than share it.
- **Tests.** `sync-org-entries.test.ts` drives the whole function through its KV output, so it should survive the split
  unchanged.

**JUDGE-BACKFILL-FLAG.** `judge-evaluations --backfill` (`runBackfill`, plus `discoverSessionsFromTraces`) writes
seeded, synthetic `trace-backfill` scores — the kind of output `populate` refuses to produce without an explicit
`--seed`. It is documented nowhere and nothing invokes it; its tests do touch it. Keep (and document) or remove: a
product decision, not a refactor.

**DEPLOY-SECRETS-DEV-WORKER.** `scripts/deploy-secrets.sh` (`npm run deploy:secrets`) sets secrets on the two production
Workers only. The dev Worker has its own Supabase project and Auth0 tenant, so the omission may be deliberate; confirm and
note it in the script, or add a dev invocation under `--config dev`.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.9](changelog/3.0.9/CHANGELOG.md) (2026-10-05).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
