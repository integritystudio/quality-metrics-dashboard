# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

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

Interim state (2026-08-22): the previously-flagged index reads in `scripts/sync-to-kv.ts` no
longer go through `Record` indexing at all — the sync state is a `Map<string, KvSyncEntry>`
(`loadSyncState`/`saveSyncState` convert at the file boundary) and the span/agent/eval
accumulators use `d3-array` `rollup`, so reads are honestly `V | undefined` without a
helper. `import.meta.dirname` goes through `importMetaDirname()`
(`src/lib/dashboard-file-utils.ts`), a runtime `typeof` check rather than an
`as string | undefined` assertion. Neither change depends on the flag, so nothing here needs
unwinding when parity lands.

To fix:
1. Bring the parent repo's `src/lib/**` clean under `noUncheckedIndexedAccess` (its own pass).
2. Add the flag to `tsconfig.scripts.json`; fix the remaining `scripts/**` errors
   (`derive-evaluations.ts` and script tests at the time; `sync-to-kv.ts`'s count will be
   lower than the ~25 originally measured after the 2026-08-22 change).

Completed items migrated to [docs/changelog/](changelog/) — most recently [v3.0.7](changelog/3.0.7/CHANGELOG.md) (2026-08-17).
