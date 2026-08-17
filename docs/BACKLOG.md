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

### `tsconfig.scripts.json` lacks `noUncheckedIndexedAccess` parity with root (SCRIPTS-TSCONFIG-NUIA)

**Priority**: P3 | **Source**: session 2026-08-17 (lint cleanup of `no-unnecessary-condition`)

Root `tsconfig.json` has `noUncheckedIndexedAccess: true`; `tsconfig.scripts.json` does not.
So under the scripts config, record lookups like `state[key]` falsely type as always-present,
which made eslint's `no-unnecessary-condition` flag **load-bearing runtime guards** as dead
code — deleting them would have introduced real bugs in the production sync path.

Enabling the flag was attempted this session and reverted: it produced **169 typecheck
errors, roughly half in the parent repo's `../src/lib/**`** (the scripts config's `include`
reaches `../dist`, and errors surfaced in parent quality/judge/audit modules —
`qfe-correlation.ts` alone had 27). Fixing those belongs to the parent observability-toolkit,
not this repo, so parity is a cross-repo pass, not a one-line config change.

Interim state (2026-08-17): `scripts/sync-to-kv.ts` carries a local
`lookup<V>(rec, key): V | undefined` helper routing the previously-flagged index reads
(`filterChanged`, `computeSpanLatency`, agent/eval accumulators, meta-key hash checks) so the
guards are justified by honest types. `import.meta.dirname` uses are asserted
`as string | undefined` (`SCRIPT_DIR` in sync-to-kv, local const in `backtest-degradation.ts`)
because a plain annotation gets flow-narrowed back to `string`.

To fix:
1. Bring the parent repo's `src/lib/**` clean under `noUncheckedIndexedAccess` (its own pass).
2. Add the flag to `tsconfig.scripts.json`; fix the remaining `scripts/**` errors
   (~25 in `sync-to-kv.ts`, ~12 in `derive-evaluations.ts`, plus script tests at the time).
3. Remove the `lookup()` helper and the `as string | undefined` assertions — they become
   redundant once index reads type honestly.

### `derive-evaluations.ts` template-literal lint warnings (DERIVE-EVAL-LINT-STRINGIFY)

**Priority**: P4 | **Source**: session 2026-08-17 (lint cleanup)

The 13 remaining lint warnings are all here: `no-base-to-string` /
`restrict-template-expressions` from interpolating untyped span attributes
(`attrs['session.id']`, `gen_ai.agent.name`, etc.) into template literals — attribute values
type as `{}`/`unknown`, so a non-string would render `[object Object]` into derived metric
keys. Fix by narrowing through a typed accessor (cf. `spanAttr` in `sync-to-kv.ts`) rather
than casting at each site.

Completed items migrated to [docs/changelog/](changelog/) — most recently [v3.0.6](changelog/3.0.6/CHANGELOG.md) (2026-07-13).
