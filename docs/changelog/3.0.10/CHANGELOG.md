# v3.0.10 (2026-10-08)

One session detail and one step-scoring rule for both the dev API and the KV sync, plus the
de-duplication of `scripts/sync-to-kv.ts` and its tests. The KV values the sync writes, and their
change hashes, are unchanged by every commit here; a 2,000-session randomized comparison against the
previous builder matched byte for byte.

## Refactors

| Commit | Change |
|--------|--------|
| `70256b2` | The session detail is built once, in `src/api/session-detail.ts` (`computeSessionDetail`), for both `GET /api/sessions/:sessionId` and the `session:<id>` KV entries. The two copies had drifted (SESSION-DETAIL-DRIFT). The parent's multi-agent evaluator is passed in, because the API reaches it through its `parent/` barrel and the sync from the parent's source. |
| `86ae245` | Agent attribution reads `gen_ai.agent.name` only. The pre-OBP7b `agent.name` stopped on 2026-07-12, older than the 30-day window every reader uses by default. |
| `af7f3b8` | `sync-to-kv.ts`: shared helpers (`validScores`, `groupByMetric`, `previewKeys`, `recordWritten`, `tracePriority`), `hitCap` tracked as a boolean rather than parsed back out of a log line, and the coverage entry routed through the same change check as every other entry. Tests: `kv-bulk-put` and `kv-bulk-delete` merged into `kv-bulk.test.ts`; evaluation fixtures shared through `scripts/__tests__/support/evaluations.ts`. |

## Fixes

| Commit | Change |
|--------|--------|
| `fa98815` | `GET /api/agents/:sessionId` (and `/graph`) scored a step as failed only on status `'ERROR'`, so a span that failed by `integritystudio.agent.has_error` or `integritystudio.tool.has_error` scored 1 there and 0 in the workflow graph KV serves. The route now takes its step scores from `sessionStepScores` in `session-detail.ts`. |

## Behaviour changes

**Judge failure classification sees more of a non-`Error` throw (`af7f3b8`).** Eleven
`err instanceof Error ? err.message : String(err)` sites in `scripts/` now call the parent's
`describeUnknown` (`src/lib/core/describe-unknown.ts`). For an `Error`, and for a primitive, the text
is the same. For a thrown plain object it is now the object's JSON rather than `[object Object]`.
Two of those sites feed `classifyJudgeFailure`, which buckets by pattern
(`scripts/judge-failures.ts` `trackFailure`, `scripts/judge-consolidated.ts` `trackFailure`), so such a
throw whose JSON names a status or condition (`429`, `timeout`, …) is now counted under that class
instead of `other`, and can move the high-failure-rate signal. Kept deliberately: the class is more
accurate, and the Anthropic SDK and `fetch` throw `Error` subclasses, so plain-object throws are rare.
When comparing `failureClasses` across this date, expect `other` to shrink rather than reading it as
a change in the judge.

The remaining sites only change log text: the sync's bulk-put, config-parse and org-discovery
warnings, and the judge and backtest scripts' error lines.
