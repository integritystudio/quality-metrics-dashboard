# v3.0.8 (2026-08-28)

Closes the last item in this repo's backlog: `noUncheckedIndexedAccess` parity between
`tsconfig.scripts.json` and the root config, and the scripts-directory type-safety rules
promoted from warn to error behind it.

## Type Safety — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| SCRIPTS-TSCONFIG-NUIA | `tsconfig.scripts.json` reaches `noUncheckedIndexedAccess` parity with root | P3 | `noUncheckedIndexedAccess: true` added to `tsconfig.scripts.json` (`733402d`); `scripts/` type-safety rules promoted from warn to error (`a76f475`); shared rules deduped in `eslint.config.mjs` (`01f1294`). All 93 errors from the 2026-08-27 re-measurement resolved. |

## Why it took two repos and three attempts

**The flag was not a one-line config change, and the first attempt proved it.** Enabling it on
2026-08-17 produced **169 typecheck errors, roughly half in the parent repo's `../src/lib/**`** —
the scripts config's `include` reaches `../dist`, so errors surfaced in parent quality/judge/audit
modules (`qfe-correlation.ts` alone had 27). Fixing those belonged to the parent
observability-toolkit, not here. Reverted.

**The parent's half landed 2026-08-27**, in the parent repo: all 79 files under its `src/lib/**`
(863 errors — 157 production, 706 test) fixed across two passes. The second pass is the one worth
remembering: the first pass used non-null assertions backed by provable invariants, which
**silently broke `npm run lint` there**, because the parent's eslint bans
`@typescript-eslint/no-non-null-assertion` as an **error** in production code (only `warn` in
tests). Every production `!` was converted to an explicit `if (x === undefined) throw` guard.

**Re-measuring is what made the remaining work legible.** With the flag temporarily flipped on and
reverted (2026-08-27): **93 errors in 11 files, all confined to `scripts/**` here** — zero reached
`../dist` or the parent, which confirmed the cross-repo half was actually gone rather than
plausibly gone. The `~25` estimate for `sync-to-kv.ts` carried from an earlier note undercounted;
it was 24 in the file plus 7 more in its own test file.

## The finding that outlives the item

Under the scripts config, record lookups like `state[key]` typed as always-present, which made
eslint's `no-unnecessary-condition` flag **load-bearing runtime guards as dead code**. Deleting
them — the obvious response to the lint warning — would have introduced real bugs in the
production sync path. **A lint rule is only as sound as the type information under it**; a
"redundant" check under a config missing `noUncheckedIndexedAccess` is not redundant.

## Interim state, preserved (2026-08-22)

Recorded here because it explains why the final error count came in *below* the original
estimate. Before parity landed, the previously-flagged index reads in `scripts/sync-to-kv.ts`
stopped going through `Record` indexing at all: the sync state became a
`Map<string, KvSyncEntry>` (`loadSyncState`/`saveSyncState` convert at the file boundary) and the
span/agent/eval accumulators moved to `d3-array` `rollup`, so reads are honestly `V | undefined`
without a helper. `import.meta.dirname` goes through `importMetaDirname()`
(`src/lib/dashboard-file-utils.ts`), a runtime `typeof` check rather than an
`as string | undefined` assertion. Neither change depended on the flag, so nothing needed
unwinding when parity landed.
