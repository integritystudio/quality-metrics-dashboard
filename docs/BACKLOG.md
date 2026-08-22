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

Completed items migrated to [docs/changelog/](changelog/) — most recently [v3.0.7](changelog/3.0.7/CHANGELOG.md) (2026-08-17).
