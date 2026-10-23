# Judge/Sync Test Suite Audit — 2026-10-22

Per-test verdict and mutation spot-check for DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE, over the seven
`scripts/__tests__` files rewritten in `1cd6dd8`/`e18b2be`: `judge-evaluations`, `pipeline-integration`,
`derive-evaluations`, `sync-prioritization`, `judge-hallucination-eval`, `judge-consolidated`,
`judge-selection`. Criteria are the five in the backlog entry (contract not internals, three paths,
real collaborators, assertions that can fail, fixtures earn their constants).

**Every test not listed below is _keep_.** Listed tests are _rewrite_ or _delete_; **Landed** marks the
ones changed on branch `test/judge-suite-mutation-check`.

## Mutation spot-check

One mutant at a time, run against the seven files only; the source restored after each run.

| Module:line | Mutation | Before | After |
|---|---|---|---|
| judge-failures:153 | success-rate drop `>` → `>=` | survived | killed |
| judge-failures:184 | high failure rate `>` → `>=` | survived | killed |
| judge-failures:152 | min attempts `<` → `<=` | survived | killed |
| judge-usage:153 | tool turn `> 0` → `>= 0` (per-criterion) | killed | killed |
| judge-usage:174 | tool turn `> 0` → `>= 0` (consolidated) | survived | survived¹ |
| judge-selection:67 | judged `=== 0` → `> 0` | killed | killed |
| judge-selection:70 | withheld `=== null` → `!== null` | killed | killed |
| judge-dedup:43 | synthetic cohort negated | survived | survived¹ |
| judge-dedup:63 | backfill cohort dropped | survived | survived² |
| judge-hallucination-eval:198 | complement `<` → `>` | survived | killed |
| judge-hallucination-eval:294 | measured spend cap `<` → `<=` | survived | survived³ |
| judge-hallucination-eval:173 | tool turn `> 0` → `>= 0` | killed | killed |
| judge-turns:367 | context item cap `<=` → `<` | killed | killed |
| judge-turns:321 | keep last tool results → first | survived | killed |
| judge-turns:246 | tool-result-only `> 0` → `>= 0` | killed | killed |
| judge-evaluations:255 | canary rate `<` → `>=` | survived | killed |
| judge-evaluations:395 | tool turn `> 0` → `>= 0` | killed | killed |
| judge-evaluations:713 | turn limit `Math.min` → `Math.max` | survived | survived³ |
| judge-evaluations:516 | lock pid `<= 0` → `< 0` | survived | killed |
| derive-evaluations:229 | epoch guard inverted | killed | killed |
| derive-evaluations:405 | min handoff agents `<` → `<=` | killed | killed |
| derive-evaluations:418 | handoff threshold `>=` → `>` | survived | survived⁴ |
| derive-evaluations:504 | completion-age guard inverted | killed | killed |
| derive-evaluations:705 | drift min spans `>=` → `>` | survived | killed |
| derive-evaluations:335 | ratio fallback `Math.min` → `Math.max` | survived | killed |
| sync-to-kv:304 | trace budget `-` → `+` | killed | killed |
| sync-to-kv:398 | KV chunk bytes `>` → `>=` | survived | survived⁵ |
| sync-to-kv:554 | recency `1 -` → `1 +` | killed | killed |
| judge-consolidated:348 | min steps `<` → `<=` | killed | killed |
| judge-consolidated:413 | normalisation range `+ 1` | killed | killed |
| judge-consolidated:251 | tool turn `> 0` → `>= 0` | killed | killed |
| judge-consolidated:580 | `max_tokens` stop reason inverted | survived | killed |

**15 → 25 of 32 killed.** Every module under test now has a killed mutant within the seven files except
`judge-dedup`, whose live code is covered by `judge-cloud-source.test.ts`.

1. Survives the seven; a test outside them kills it (`judge-consolidated-batch.test.ts`, `judge-cloud-source.test.ts`).
2. Dead code: `isThisScriptsRecord` has had no caller since `88e69e4`.
3. Inside `main()` (the turn-limit clamp, the `canSpend` closure); needs a pure helper extracted to test.
4. Equivalent: the handoff score is `hasError ? 0 : 1`, so nothing reaches 0.5.
5. `chunkKvPairs` belongs to `kv-bulk.test.ts`, which has no row at exactly `maxBytes`.

## Verdicts

### judge-evaluations.test.ts (137 tests)

| Test | Verdict | Status |
|---|---|---|
| summarizeJudgeRun › treats a wall-clock overrun as soft | delete — duplicate of `pipeline-stages.test.ts` | Landed |
| summarizeJudgeRun › RUN_OUTCOMES | rewrite — rows bracketed every threshold but none sat on one | Landed (50%, 25-point, 50-attempt rows) |
| acquireLock › reclaims a lock left by … | rewrite — no pid `0` row | Landed |
| extractTurns | rewrite — the 20-result cap was never exercised | Landed (keeps-the-latest test) |
| seedEvaluations | rewrite — canary share never bounded | Landed (minority test) |
| fitContextForJudge › keeps at most the item limit | rewrite — asserts only length | Remaining; blocked on the context-order finding below |
| summarizeJudgeRun › carries the usage totals … | rewrite — `toBeCloseTo` where exact may hold | Remaining |
| estimateJudgeRun › counts two evals … four for one with tools | rewrite — `inputTokens > 0` cannot fail usefully | Remaining |
| estimateJudgeRun › list rates, no discount by default | rewrite — two behaviours; `toBeCloseTo` | Remaining |
| estimateJudgeRun › batch discount only on cost | rewrite — `toBeCloseTo` on an exact halving | Remaining |
| evaluateTurn in concurrent mode › issues every criterion first | rewrite — fixed `SETTLE_MS` sleep; use `vi.waitFor` | Remaining |
| evaluateTurnsBatched › throws on flush reject / recorded failure | rewrite — two behaviours; `it.each` | Remaining |
| toOTelRecord › flat OTel format | rewrite — model literal instead of `HAIKU_MODEL` | Remaining |

### judge-consolidated.test.ts (40 tests)

| Test | Verdict | Status |
|---|---|---|
| selectCriteria › skips the tool sub-criteria when tool_correctness exists | rewrite — filter then `toEqual([])` passes on an empty selection | Landed |
| selectCriteria › under directHallucination, drops faithfulness … | rewrite — name did not match the fixture; loose `toContain` | Landed |
| createConsolidatedProvider (new) | — `max_tokens` path had no test; seam is `ANTHROPIC_BASE_URL` + the recording server | Landed |
| buildConsolidatedPrompt › which parts each criterion applies to | rewrite — label not tied to its criterion | Remaining |
| buildConsolidatedPrompt › steps prompt matches the per-criterion path | rewrite — tests `buildStepsPrompt` under the wrong describe | Remaining |
| parseConsolidatedResponse › rejects fraction/zero/string/missing | rewrite — drive through `parseConsolidatedResponse`, qualify `toThrow` | Remaining |
| parseConsolidatedResponse › throws when not a JSON object | rewrite — two cases, unqualified `toThrow()` | Remaining |
| evaluateTurnConsolidated › per-criterion path's records from one call | rewrite — compares two constants; split | Remaining |
| evaluateTurnConsolidated › skips existing keys; nothing when all exist | rewrite — two behaviours | Remaining |
| evaluateTurnConsolidated › retries steps after a failure | rewrite — `toContain('1. ')` is weak | Remaining |

Rejected: deleting `selects nothing when every key exists` (it is the empty-result boundary, not a
duplicate) and dropping the `cache.has` assertion (the cache is a caller-supplied parameter).

### sync-prioritization.test.ts (14 tests)

| Test | Verdict | Status |
|---|---|---|
| prioritizeTraces › ranks a trace without evaluations last, as if it scored 1 | rewrite — recency decided the order, not the score | Landed (fails when the unscored default is 0.5) |
| prioritizeTraces › groups org-prefixed and bare entries as a single unit | rewrite — one trace cannot show grouping | Landed |

### judge-hallucination-eval.test.ts (8 tests)

| Test | Verdict | Status |
|---|---|---|
| countComplements › counts turns whose scores sum to 1 | rewrite — symmetric fixture hid an inverted comparison | Landed |
| parseArgs › explicit path; refuses missing | rewrite — happy and error path in one test | Remaining |
| closestConfiguration › lowest MAE, ties … | rewrite — three behaviours | Remaining |
| estimateRunSpend › one reference call per tool turn | rewrite — one tool turn cannot show "per"; `toBeCloseTo` | Remaining |

### judge-selection.test.ts (10 tests)

| Test | Verdict | Status |
|---|---|---|
| turnSkip › holds an unstamped turn when the webhook secret is missing | rewrite — also asserts the opposite case | Remaining |

### derive-evaluations.test.ts (84 tests)

| Test | Verdict | Status |
|---|---|---|
| task completion › TASK_SESSIONS | rewrite — the only ratio-fallback row sat at the 1.0 cap | Landed (0.5 and over-cap rows) |
| detectInputDrift › ignores a day with too few tool spans | rewrite — 5 spans is far from the 20-span floor | Landed (19 and 20 rows) |
| detectInputDrift › tolerates hooks … up to half the day | rewrite — `half` named 24 of 48 | Landed (renamed) |
| deriveAll › gives the same records when run twice | rewrite — vacuous; removing the agent reset passed | Landed (fails with the reset removed) |
| renamed agent hook spans › attaches session records … whatever order | rewrite — passed if both runs returned `[]` | Landed |
| scoreTask | delete — pins a test-only export | Remaining (with the move below) |
| task completion › TASK_SESSIONS, UNSCORED_SPANS, each session on its own tasks; task tracking builtin rename | rewrite — drive through `deriveAll`, then drop the test-only accumulator exports | Remaining |
| deriveEvaluationLatency › no duration at all | delete — same path as the non-finite case | Remaining |
| readScope › keeps the caller's dates | rewrite — pins reference identity | Remaining |
| splitAtRepostFloor › sits at 2026-09-28T00:00Z | delete — restates the constant | Remaining |
| resolvePostDays › reads the day count | rewrite — two spellings; `it.each` | Remaining |
| deriveAll › stamps records with the account | rewrite — one span and one account cannot tell them apart | Remaining |
| deriveAgentHeuristics › subagent run with labels | rewrite — `agent_overall` score never asserted | Remaining |
| deriveAgentHeuristics › stable session keys | rewrite — `> 0` plus prefix filter; assert the three keys | Remaining |

### pipeline-integration.test.ts (2 tests)

| Test | Verdict | Status |
|---|---|---|
| derive → OTel › completed task as rule-scored evaluation | rewrite — expected timestamp came from the code under test | Landed |
| derivedTaskCompletion helper | rewrite — build from `deriveAll` | Remaining (with the derive move) |

## Findings outside the tests

- **The judge never sees a turn's newest tool results.** `extractTurns` keeps the last
  `MAX_TOOL_RESULTS_PER_TURN` (20); `fitContextForJudge` then keeps the first `MAX_TOOL_CONTEXT_ITEMS`
  (10) of those, so the 10 most recent are dropped. Filed as DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS.
- **`isThisScriptsRecord` (`judge-dedup.ts`) is dead** since `88e69e4` dropped the local source.
