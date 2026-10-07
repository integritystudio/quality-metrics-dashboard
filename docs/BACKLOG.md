# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Testing

No open items.

### Behaviour

No open items.

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

**PHASE6-LOCAL-RETIREMENT.** The cloud-read roadmap (`../../docs/roadmap/dashboard-cloud-read-migration.md:166`) keeps
`--source=local` for one release after the 2026-10-04 default flip, then deletes it. That release removes ~900 lines:
`derive-parity.ts`, `judge-parity.ts`, `trace-coverage.ts` (or keep it as a shipper-health check — decide),
`account-stamps.ts` (apart from what judge option A needs), derive's `loadLocalSpans`, and the judge's local discovery and
`_loadExistingKeys`, plus their tests. Do not start before the rollback window closes.

**SYNC-ORG-ENTRIES-SPLIT.** `computeOrgEntries` (`scripts/sync-to-kv.ts:972`) runs ~480 lines. Split into period
entries, metric detail, trends + degradation, and sessions + agents (with an `accumulateAgent()` for the block in the
session loop). The nanosecond window `BigInt(x.getTime()) * NANOSECONDS_PER_MILLISECOND_BIGINT` is built 13 times and
query-then-warn-on-cap repeated 4 times (`nsRange()` / `queryEvalsWarnCap()`); `kvBulkPut` (`:360`) and `kvBulkDelete`
(`:414`) repeat the batch/temp-file/`execFileSync`/stderr scaffolding (`runWranglerBulk()`).

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
