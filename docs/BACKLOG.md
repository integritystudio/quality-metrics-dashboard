# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-SYNC-90D-PERIOD | Write the `90d` KV entries and lift the header's 90d data gate | P3 | `'90d'` is a full period in code, but the parent's `kv-sync` Workflow caps `maxDays` at 30, so no `:90d` entry exists and `DATA_GATED_PERIOD` hides the button. Split out of DASH-LINT-PARENT-PARITY on 2026-10-21. Source: session 2026-10-18 |

**DASH-SYNC-90D-PERIOD.** `DEFAULT_LOOKBACK_90D` is `PERIOD_MS['90d']`: `'90d'` is a full period
(`PERIOD_KEYS`, `VALID_PERIODS`, `PERIOD_MS`, the header selector, shortcut `4`, and the Workflow's
`periodWindows`, which filters `PERIOD_KEYS` instead of keeping its own copy of the list). ⚠️ **The
parent's `kv-sync` Workflow caps `maxDays` at `LONGEST_PERIOD_DAYS` (30)**
(`services/kv-sync-workflow/src/index.ts`), and `periodWindows` skips a period longer than the window,
so no `:90d` KV entry is written. The cap was left alone deliberately: the whole-org build held
~1.65 GB in memory at 30 days, and the evaluation read spans `METRIC_DETAIL_WINDOWS` × the window. The
parity tests' `it.each` period lists do not cover `90d`.
- **So the header hides 90d until it has data.** `DATA_GATED_PERIOD` (`constants.ts`) names it;
  `Layout` asks `useOfferPeriod` — `useDashboard` for that period, which maps the worker's
  `ERR_NO_DATA` 404 to a `no_data` summary — and shows the button, and registers shortcut `4`, once a
  real summary comes back, when the check **fails** (so an outage never hides a period that has data),
  or while 90d is the selected period; it stays hidden only while the first check loads and on a
  no-data answer. `Layout.test.tsx` covers those five states against the real query stack. The gate
  re-checks every `DATA_GATE_POLL_INTERVAL_MS` (an hour, the KV refresh cadence) rather than the
  page's 30 s; react-query polls at the shortest interval among a key's observers, so it drops to
  30 s only while the 90d page itself is open.
- **The Workflow's limits are the blocker, not the flag.** Raising `LONGEST_PERIOD_DAYS` triples each
  evaluation partition's read; a step gets 128 MB and its output 1 MiB (parent
  `docs/archive/kv-sync-in-worker.md`). Measure a 90-day run against the dev Workflow before raising
  the cap. The prune step's `config.maxDays < LONGEST_PERIOD_DAYS` guard moves with it.
- **Measured 2026-11-21: D1, not the Worker, is the limit.** There is no dev Workflow, so a throwaway
  `dashboard-kv-sync-measure` (cap raised to 90, `crons = []`, preview KV bound, prod D1) ran
  `{dryRun: true, maxDays: 90}`, then was deleted. Every evaluation step passed (90d partitions hold
  ~3.4× the 30d rows: 3,948 relevance samples against 1,166; `metric:*:90d` steps 12–15 s, no memory
  or 1 MiB output error). The home org's first `sessions:` step failed every retry with
  `D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window` and the run
  errored after 7 min. `computeSessionsStep` reads each session's spans by
  `attributeFilter: { session.id }` over the whole window, 25 sessions a step, and at 90 days one step
  exceeds D1's per-window budget.
- **Cause: the planner's index choice, not a missing index.** `EXPLAIN QUERY PLAN` on prod showed the
  per-session span read and both trace-batch reads (`queryTraceSpans`, `queryTraceEvaluations`)
  taking `(org_id, time)` and walking the org's whole window per session or per 90-id chunk:
  216,859 rows per session read at 90 days (32,418 at 30) against 778 through
  `idx_traces_session_time`, and 216,859 / 158,264 per trace chunk against 6,998 / 6,040 by
  `trace_id`. The parent's `d1-read-backend.ts` now steers all three (`INDEXED BY` for sessions,
  unary-`+` org and window for trace batches), with plan tests that fail on the old choice. With the
  session fix alone a 90-day dry run passed every `sessions:` step and failed at `traces:2`.
  A first attempt ran 30d and 90d concurrently and both hit the same error on prod D1 between
  20:05 and 20:14 local; the 20:00 production run had already finished. Never run two syncs at once.
- **Checked 2026-11-22: still no `:90d` entry** in production KV, bare or under the home org
  (`dashboard:90d`, `metric:relevance:90d`). The next step is unchanged: a 90-day dry run on prod D1 with
  the trace-batch plan fix, through a rebuilt throwaway measurement Workflow, never beside a scheduled sync.

Acceptance: the scheduled Workflow writes the `:90d` entries, the `it.each` period lists in the parity tests
cover `90d`, `DATA_GATED_PERIOD` and `useOfferPeriod` are deleted, and e2e asserts all four periods
(today it asserts only the three always-offered ones, since the fourth depends on the environment's data).

### API client

No open items.

### Admin customer view

No open items.

### API keys

No open items.

### Security

No open items.

### Tooling and config

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-TEST-CLOSE-TO-DIGITS-SUPPORT | Move the 10-digit `toBeCloseTo` precision into `scripts/__tests__/support/` | P4 | Leftover of DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE (changelog 3.0.13). Source: session 2026-11-21 |

**DASH-TEST-CLOSE-TO-DIGITS-SUPPORT.** The same 10-digit precision is declared under two names in three
files: `COST_CLOSE_TO_DIGITS` in `judge-consolidated-batch.test.ts` (module scope) and
`judge-evaluations.test.ts` (inside a `describe`), and `USD_PRECISION_DIGITS` in
`judge-quality-eval.test.ts`. The judge-suite audit flagged it as the one constant that belongs in
`support/`, which the magic-number sweep was told not to touch.
Acceptance: one exported constant in `scripts/__tests__/support/`, the three local copies gone, and
`npm run test:scripts` green.

### Consolidation

Small duplications found by the 2026-11-21 review of `docs/repomix/repomix.xml`. Each saves a few
hundred tokens at most; none is a defect. Savings are chars/4 estimates.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.13](changelog/3.0.13/CHANGELOG.md) (2026-11-21).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
