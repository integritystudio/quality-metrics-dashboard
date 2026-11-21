# Populate Pipeline: Cost of Replacing the Local Job

Compares the approaches for running the dashboard populate pipeline
(`derive → judge → sync-to-kv`) without a local `evaluations-*.jsonl` stage.
Measured 2026-08-22 against local telemetry (`~/.claude-history/telemetry`) and
the deployed obtool-api/D1.

## Starting point

`scripts/sync-to-kv.ts` already reads only the cloud API (`/v1/evaluations`,
`/v1/traces`); it never reads `evaluations-*.jsonl`. The local file is an input
to the two **producers** upstream of it, whose output never reaches the D1
`evaluations` table that sync-to-kv reads:

| Stage | Input | Input available in the cloud? |
|---|---|---|
| `derive-evaluations.ts` (rule-based: `tool_correctness`, `evaluation_latency`, `task_completion`, `handoff_correctness`) | hook spans + attributes | Yes — `traces_metadata.attributes` is stored as TEXT in D1; no R2 read needed |
| `judge-evaluations.ts` (LLM: relevance, coherence, faithfulness, hallucination) | user/assistant/tool-result text from session transcripts | No — shipped logs carry only `transcript.path`; no message content leaves the machine |
| `sync-to-kv.ts` (aggregates → KV) | `/v1/evaluations`, `/v1/traces` | Yes |

Measured volume, last 30 days (local): 191k spans / 164 MB, 146k evaluations
(99.7% rule-based, zero `llm`-evaluator records), 417 sessions, 11,639 turns.
The D1 `evaluations` table holds 4 rows (all e2e). KV `meta:lastSync` is
2026-04-14 with `overallStatus: no_data`.

## Prerequisite common to every approach: shipping completeness

A cloud pipeline computes over what reached D1. Hooks spans per day, local vs D1:

```
08-12  8203 →    4      08-16  5702 →    0
08-13  6001 →    2      08-17  7942 → 1222
08-14  5870 →    0      08-18  1222 → 1245
08-15  3052 →    0      08-22  5921 → 1265   (cursor == file size; D1 lags R2 ~4.5 h)
```

This is the third shipper stall of the same shape (see global CLAUDE.md,
"Only TRACES prove the shipper is alive"). `backlog-ship-state.json` shows the
pre-seeded-cursor backfill works (07-18 was replayed), so it is recoverable.
Until it is, any Worker-side pipeline lights the dashboard with ~5–10% of real
volume. Cost: **~1 day** (pre-seed cursors for 08-12→08-16, confirm D1 catches
up, add a staleness alert on `claude-code-hooks` traces). Counted once, below,
as item 0.

## Approaches

### A. Keep the local job, schedule it, bridge its output to the cloud

Schedule `npm run populate` (cron/launchd) and add an `evaluations` signal to
the span-shipper that posts `evaluations-*.jsonl` lines as HMAC-signed batches
to `POST /v1/evaluations` (the ingest flush already handles the `evaluations`
segment → D1 table).

- Engineering: 0 (1 d) + shipper signal 1–2 d + scheduling 0.5 d = **2.5–3.5 d**
- Recurring: Cloudflare $0 incremental; Anthropic $0 (derive only) or ~$200/mo
  if the batch judge runs on every turn (see LLM spend)
- Runs only while the laptop is on and the cron fires; this is the failure mode
  that produced the current 4-month gap. Does not meet "no local job".

### B. Derive Worker over D1 + existing kv-sync Workflow (no LLM metrics)

Cron Worker: `SELECT … FROM traces_metadata WHERE name IN ('hook:builtin-post-tool',
'hook:mcp-post-tool', …) AND start_time_ns > watermark`, port the ~330 lines of
`derive*` functions, `INSERT INTO evaluations`. Calibration state moves from
`.calibration-state.json` to KV `meta:calibration`. Then finish
`services/kv-sync-workflow` (currently period aggregates only; missing `trend:`,
metric detail, `session:`/`trace:`/`agent:` keys, canary filter; not deployed).

- Engineering: 0 (1 d) + derive Worker 2–3 d + Workflow port 3–5 d = **6–9 d**
- Recurring: Cloudflare ~$5/mo (Workers Paid, already implied by existing
  crons/KV); D1 ~150k row writes/mo vs 50M included; KV ~4k writes/mo vs 1M
  included; Workflow CPU is I/O-bound. Anthropic **$0**.
- Delivers 3 of 7 metrics. Fully serverless, no content leaves the machine.
- Runtime constraint: 128 MB isolate memory, 1 MiB Workflow step output. 30 d
  of spans is ~110 MB as API JSON, so the Workflow's current one-step
  `count-spans` shape will OOM at full shipping volume. Aggregate in D1 SQL
  (`GROUP BY session_id`/`name`) or bucket by day; do not pull raw rows into
  the isolate. Also: the KV namespace holds 172k accumulated `trace:`/
  `session:` keys and nothing prunes them.

### C. B + ship the Stop-hook T2 judge output

The Stop hook already runs an LLM judge locally at session end
(`hooks/handlers/stop.ts`, `quality-evaluation-t2`): 10% of sessions,
3 turns/session, Haiku, `DAILY_BUDGET_CENTS = 50`. Its records go to
`evaluations-*.jsonl` and are never shipped. Add the shipper `evaluations`
signal from approach A so they reach D1. (Currently inert: the Anthropic
account is out of credit — the killed judge run logged
"credit balance is too low" on every call.)

- Engineering: B + 1–2 d = **7–11 d**
- Recurring: Cloudflare ~$5/mo; Anthropic **≤ $15/mo**, bounded in code
- Delivers 7 of 7 metrics at the sampled rate. The judge still runs on the
  laptop, but inside a hook that already executes — there is no separate
  job to schedule or forget. Transcript text never leaves the machine.

### D. Fully cloud judge (no local component at all)

Hook emits a content log event per turn (stop.ts already caps at 500/2000
chars; R10 redaction in `src/lib/privacy/content-redaction.ts` applies), a
Cloudflare Queue consumer calls the Anthropic API from a Worker and writes to
D1 `evaluations`.

- Engineering: B + 4–6 d = **10–15 d**
- Recurring: Cloudflare ~$5/mo + Queues (within included at this volume);
  Anthropic same tokens as wherever else the judge runs — $15/mo at the T2
  sampling policy, ~$200/mo for every turn
- Only approach with zero local dependency. Turn content starts leaving the
  machine; a Workers invocation is capped at 1000 subrequests and 30 s CPU
  (configurable to 5 min), so batching through Queues is required, not optional.

### E. B + Agent-as-Judge instead of LLM-as-Judge, as a Worker job

`src/lib/agent-judge/` (`agent-as-judge.ts`, `agent-judge-classes.ts`,
`agent-judge-consensus.ts`, `agent-judge-verification.ts`) is a separate
evaluation framework from `llm-as-judge.ts`. It is pure TS with no Node-only
imports (`fast-deep-equal` is the only non-relative dependency), so it runs in
a Worker with no porting work — unlike `derive-evaluations.ts` and
`judge-evaluations.ts`, it needs no rewrite, only wiring. It is not currently
called from anywhere (`src/server.ts`, `src/tools/`, and the dashboard scripts
have no references) — the estimate below is for building the wiring, not
replacing an existing call site.

**What actually costs money is the wiring, not the framework.** The
scaffolding functions (`scoreStep`, `verifyToolCalls`, `analyzeTrajectory`,
`aggregateStepScores`, `calculateVariance`/`calculateMedian`) are pure
rule-based code — free, same as `derive-evaluations.ts` today. Every LLM call
comes from a function the caller injects: `ProceduralJudge`'s per-stage
`evaluate`, `ReactiveJudge`'s `specialists`/`deepDiveSpecialists`, or
`collectiveConsensus`'s `judges[].evaluate`. Cost depends entirely on which of
these three shapes replaces `judge-evaluations.ts`'s one-G-Eval-call-per-metric
pattern:

| Shape | LLM calls per turn vs. today | 30-day Anthropic cost (full coverage, Haiku) |
|---|---|---|
| `ProceduralJudge`, one stage per metric (closest parity to today) | ~1× — same call count, +10–20% input tokens for the accumulating `context` object passed into later stages | **~$220–230/mo** (vs. $199 today) |
| `ReactiveJudge` (router + specialists, no deep dive) | ~1–2× — a router call per turn plus one call per routed specialist | **~$250–400/mo** |
| `collectiveConsensus`, N judges × R rounds per metric — the reason to pick this framework over a single G-Eval call | N×R — capped at `MAX_CONCURRENT_EVALUATORS=10` × `MAX_CONSENSUS_ROUNDS=5` = 50×, but a workable deployment (3 judges, 2 rounds to check `DEFAULT_CONVERGENCE_THRESHOLD=0.1`) is ~6× | **~$1,200/mo** at 3×2; **~$3,000/mo** at 5×3; **~$9,950/mo** at the 10×5 ceiling |

Rounds run concurrently within a round (`Promise.allSettled`) but sequentially
across rounds, so consensus also multiplies latency, not just cost: 2–3
sequential rounds of Haiku calls is several seconds per metric per turn. That
rules out running consensus synchronously inside a request-handling Worker —
it has to be a Queue consumer or Workflow step, same shape as approach D's
judge, since Cloudflare bills Worker CPU time, not wall-clock time spent
waiting on the Anthropic API, but a single invocation is still capped at 1000
subrequests and a bounded wall-clock duration.

- Engineering: B + wiring one shape into a Worker/Queue consumer — **3–5 d**
  for `ProceduralJudge` parity (same call graph as today, new host), **5–8 d**
  for consensus (needs the sequential-round Queue/Workflow shape, plus
  double the D1 write volume from per-judge-per-round score records if those
  are persisted individually)
- Recurring: Cloudflare unchanged from B (~$5/mo — LLM calls are I/O, not
  CPU, regardless of shape); Anthropic per the table above
- The only shape worth the switch is consensus (parity mode is llm-as-judge
  with extra steps, at extra cost); consensus buys score reliability
  (variance-based convergence) at a **6–50×** multiple of the $199/mo LLM-as-
  Judge baseline, entirely independent of whether it runs on a Worker or a
  laptop — moving it to a Worker changes engineering effort and content
  exposure, not the per-evaluation Anthropic bill.

## LLM spend (the only material dollar cost)

`judge-evaluations.ts --dry-run` (2026-08-22): 11,639 turns → 51,589 evals,
~148M input / ~10M output tokens at Haiku 4.5 ≈ **$199 per 30 days ≈ $6.6/day**.
This number is independent of where the judge runs. The Stop-hook policy
(10% × 3 turns, $0.50/day cap) bounds it at ≤ $15/mo. Historical backfill is
optional — nothing in the cloud path requires past LLM scores.

## Summary

| | Engineering | Recurring | Metrics | Local dependency | Content leaves machine |
|---|---|---|---|---|---|
| A. Local job + bridge | 2.5–3.5 d | $0–200/mo | 3–7 / 7 | Yes — cron on laptop | No |
| B. Derive Worker + Workflow | 6–9 d | ~$5/mo | 3 / 7 | None | No |
| C. B + ship Stop-hook judge | 7–11 d | ~$5 + ≤$15/mo | 7 / 7 (sampled) | Hook only | No |
| D. B + cloud judge (LLM-as-Judge) | 10–15 d | ~$5 + $15–200/mo | 7 / 7 | None | Yes (truncated, redacted) |
| E. B + Agent-as-Judge Worker (parity mode) | 9–14 d | ~$5 + $220–400/mo | 7 / 7 | None | Yes (same as D) |
| E. B + Agent-as-Judge Worker (consensus mode) | 11–17 d | ~$5 + $1,200–9,950/mo | 7 / 7, higher confidence | None | Yes (same as D) |

All rows include the 1-day shipping-recovery prerequisite.

## Recommendation

C, built in the order 0 → derive Worker → Workflow port → shipper `evaluations`
signal. B on its own gets 3 metrics live with no LLM spend; the final step adds
the LLM metrics at a code-bounded cost. Choose D only if "no local component"
is a hard requirement, since it costs ~4 extra days and a new privacy surface
for the same scores. Agent-as-Judge (E) is not a cheaper or simpler path to
"in the cloud" — it costs the same engineering as D plus wiring effort, and in
parity mode is strictly more expensive than D for the same seven metrics.
It is worth choosing only for its actual value proposition, consensus-based
score reliability, and only if that reliability is worth 6–50× today's LLM
spend.

## Cloudflare pricing assumptions

Workers Paid $5/mo: 10M requests and 30M CPU-ms included; KV 1M writes and
10M reads included; D1 50M row writes and 25B row reads included; cron
triggers and Workflows billed as Workers usage. Verify against current
Cloudflare pricing before committing budget.
