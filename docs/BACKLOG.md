# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### `sync-to-kv` throws on BigInt span timestamps (SYNC-KV-BIGINT)

**Priority**: P2 | **Source**: session 2026-08-16 (found while typing route-test fixtures)

`scripts/sync-to-kv.ts:1121` writes the `trace:<traceId>` KV entry with a raw
`JSON.stringify({ traceId, spans, evaluations: traceEvals })`. Those spans come from
`backend.queryTraces`, which sets `startTimeUnixNano: BigInt(row.start_time_ns)` and
`endTimeUnixNano: BigInt(row.end_time_ns)` (`../src/backends/cloud.ts:381-382`).
**`JSON.stringify` throws outright on `bigint`** — `TypeError: Do not know how to serialize
a BigInt` — so the call fails for any trace that actually has spans. An empty `spans` array
serializes fine, which is how this stays quiet on empty data.

Same root cause as the API-route bug fixed this session: `jsonSafe` in
`src/api/api-constants.ts`, applied at the response boundary of `routes/traces.ts`,
`routes/agents.ts`, `routes/evaluations.ts`, `routes/sessions.ts` and `routes/metrics.ts`
(both handlers). It recurses because the bigint-bearing values nest at varying depth — the
first attempt at this fix converted only the two span fields and still 500'd on the
`evaluations` array sitting beside them in the very same response body.

**The script was deliberately left untouched** — it is a production cron path
(`dashboard-populate-pipeline.ts`, `0 6,18 * * *`), and the right fix may be to normalize
once in `CloudBackend`/`data-loader` rather than at each call site.

Blast radius is **unverified**: the throw is inside `computeOrgEntries` (starts line 818) and
the only `try/catch` in that range is a narrow "skip malformed" guard, so it should propagate
to the caller at line 1310 — but whether that aborts the whole sync or just the org's entries
was not traced. An attempt to confirm against production KV was **inconclusive and should not
be repeated the same way**: `wrangler kv key list` returned `[]` for `DASHBOARD`,
`DASHBOARD_DEV` *and* the unrelated `AUTH` namespace, i.e. the Doppler `prd` token can list
namespaces but not their keys. `[]` there means "not authorized", not "empty".

To fix:
1. Decide the normalization point (reuse `jsonSafe` per call site vs. once in `CloudBackend`).
2. Whatever is chosen must also cover `evaluations` — `EvaluationResult.timestamp` is
   `bigint` too, so any KV entry embedding raw evaluations has the same latent failure.
   `sync-to-kv.ts` embeds them at line 1116 (`evaluations:trace:*`) as well as 1121.
3. Add a `scripts/__tests__` case with a bigint-timestamped span; the existing script tests
   pass because their fixtures use plain numbers.

Completed items migrated to [docs/changelog/](changelog/) — most recently [v3.0.6](changelog/3.0.6/CHANGELOG.md) (2026-07-13).
