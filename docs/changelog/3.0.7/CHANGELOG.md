# v3.0.7 (2026-08-17)

Backlog clearance: KV sync bigint serialization and a lint cleanup in the derive step.

## Data Pipeline — Resolved

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| SYNC-KV-BIGINT | KV entry values serialized through `toKVValue` | P2 | Every value in `scripts/sync-to-kv.ts` now goes through `JSON.stringify(jsonSafe(...))`, converting the backend's `bigint` timestamps (`startTimeUnixNano`, `endTimeUnixNano`, `EvaluationResult.timestamp`) to their decimal-string wire form — the same conversion the API routes apply and one `timestampToMs` accepts on the read side. `CloudBackend` left untouched (its `bigint` fields are a typed contract with other consumers). Trace-entry loop extracted as `buildTraceEntries`, covered by bigint-fixture tests in `scripts/__tests__/sync-to-kv.test.ts`. Commit: ae85fdd |
| DERIVE-EVAL-LINT-STRINGIFY | `derive-evaluations.ts` attribute reads narrowed through a typed accessor | P4 | `npm run lint` clean. Commit: 7eac08f |

**Still open:** `SCRIPTS-TSCONFIG-NUIA` (P3) — `tsconfig.scripts.json` lacks `noUncheckedIndexedAccess` parity with root; blocked on a parent-repo `src/lib/**` cleanup pass. See [docs/BACKLOG.md](../../BACKLOG.md).
