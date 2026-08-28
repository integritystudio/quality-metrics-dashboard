# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### ✅ `tsconfig.scripts.json` lacks `noUncheckedIndexedAccess` parity with root (SCRIPTS-TSCONFIG-NUIA)

**Priority**: P3 | **Source**: session 2026-08-17 (lint cleanup of `no-unnecessary-condition`)

**Status 2026-08-27 — step 1 done, step 2 (this repo) still open.** Root `tsconfig.json` has
`noUncheckedIndexedAccess: true`; `tsconfig.scripts.json` does not. So under the scripts
config, record lookups like `state[key]` falsely type as always-present, which made eslint's
`no-unnecessary-condition` flag **load-bearing runtime guards** as dead code — deleting them
would have introduced real bugs in the production sync path.

Enabling the flag was attempted 2026-08-17 and reverted: it produced **169 typecheck errors,
roughly half in the parent repo's `../src/lib/**`** (the scripts config's `include` reaches
`../dist`, and errors surfaced in parent quality/judge/audit modules — `qfe-correlation.ts`
alone had 27). Fixing those belonged to the parent observability-toolkit, not this repo, so
parity was a cross-repo pass, not a one-line config change.

✅ **Parent's `src/lib/**` is now clean under the flag (2026-08-27, done in the parent repo,
not here)**: `noUncheckedIndexedAccess: true` is live in the parent's own root
`tsconfig.json`, and all 79 files under its `src/lib/**` (863 errors — 157 production, 706
test) were fixed across two passes — first the type errors themselves (mostly non-null
assertions backed by a provable invariant, occasionally a real restructure to `for...of
.entries()`), then a second pass converting every production-file `!` into an explicit
`if (x === undefined) throw` guard, because the parent's eslint bans
`@typescript-eslint/no-non-null-assertion` as an **error** in production code (only `warn` in
tests) — the first pass's assertions had silently broken `npm run lint` there. Verified clean
end to end in the parent repo: `tsc --noEmit` (0 in `src/lib/**`), `eslint` (0 errors, 579
warnings — all in test files), `vitest run src/lib/` (2932 passed), `npm run test:unit`
(node:test, 547 passed). Nothing outside the parent's `tsconfig.json` + `src/lib/**` was
touched; not yet committed.

**Re-measured what's left for step 2, here, with the flag temporarily flipped on and
reverted** (2026-08-27): **93 errors in 11 files, all confined to `scripts/**` in this
repo** — `scripts/sync-to-kv.ts` (24), `scripts/derive-evaluations.ts` (13),
`scripts/backtest-degradation.ts` (10), `scripts/judge-evaluations.ts` (3),
`scripts/populate-dashboard.ts` (1), and six `scripts/__tests__/*.test.ts` files (46,
`pipeline-integration.test.ts` the largest at 11). **Zero errors reach `../dist` or the
parent now** — confirms the cross-repo half of the blocker is actually gone, not just
plausibly gone. The `~25` estimate for `sync-to-kv.ts` from the 2026-08-22 interim-state note
below undercounted; it's 24 in the file itself plus 7 more in its own test file.

To fix (only step 2 remains):
1. ~~Bring the parent repo's `src/lib/**` clean under `noUncheckedIndexedAccess` (its own
   pass).~~ ✅ done 2026-08-27, see above.
2. Add the flag to `tsconfig.scripts.json`; fix the remaining `scripts/**` errors (93 across
   11 files, per the 2026-08-27 re-measurement above — mostly `TS2532`/`TS18048` "possibly
   undefined", plus a handful of `TS2322`/`TS2345` assignment/argument mismatches).

Interim state (2026-08-22): the previously-flagged index reads in `scripts/sync-to-kv.ts` no
longer go through `Record` indexing at all — the sync state is a `Map<string, KvSyncEntry>`
(`loadSyncState`/`saveSyncState` convert at the file boundary) and the span/agent/eval
accumulators use `d3-array` `rollup`, so reads are honestly `V | undefined` without a
helper. `import.meta.dirname` goes through `importMetaDirname()`
(`src/lib/dashboard-file-utils.ts`), a runtime `typeof` check rather than an
`as string | undefined` assertion. Neither change depends on the flag, so nothing here needs
unwinding when parity lands — consistent with the 24-error 2026-08-27 count above, which is
lower than the ~25 originally measured pre-refactor but not zero.

Completed items migrated to [docs/changelog/](changelog/) — most recently [v3.0.7](changelog/3.0.7/CHANGELOG.md) (2026-08-17).
