# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

| ID | Title | Priority | Notes |
|----|-------|----------|-------|
| DASH-SYNC-90D-PERIOD | Write the `90d` KV entries and lift the header's 90d data gate | P3 | `'90d'` is a full period in code, but `sync-to-kv` still defaults to `--days=30`, so no `:90d` entry exists and `DATA_GATED_PERIOD` hides the button. Split out of DASH-LINT-PARENT-PARITY on 2026-10-21. Source: session 2026-10-18 |
| DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS | The judge sees a turn's oldest tool results, not its newest | P3 | Found by the judge-suite audit's mutation check. Source: session 2026-10-22 |

**DASH-SYNC-90D-PERIOD.** `DEFAULT_LOOKBACK_90D` is `PERIOD_MS['90d']`: `'90d'` is a full period
(`PERIOD_KEYS`, `VALID_PERIODS`, `PERIOD_MS`, the header selector, shortcut `4`, and `org-kv-entries`,
which iterates `PERIOD_KEYS` instead of its own copy of the list). ⚠️ **sync-to-kv still defaults to
`--days=30`**, and `computeOrgKvEntries` skips any period longer than that, so no `:90d` KV entry is
written until a run passes `--days=90`. The default was left alone deliberately: an org already holds
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
- **Memory is the blocker, not the flag.** The CLI holds a whole org in memory per period read, so a
  `--days=90` default needs either the partitioned design in the parent's
  `docs/roadmap/kv-sync-in-worker.md` or a measured run showing 90 days fits; measure before flipping
  the launchd wrapper's arguments.

Acceptance: a scheduled sync writes the `:90d` entries, the `it.each` period lists in the parity tests
cover `90d`, `DATA_GATED_PERIOD` and `useOfferPeriod` are deleted, and e2e asserts all four periods
(today it asserts only the three always-offered ones, since the fourth depends on the environment's data).

**DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS.** `extractTurns` (`judge-turns.ts`) keeps a turn's last
`MAX_TOOL_RESULTS_PER_TURN` (20) tool results. `fitContextForJudge` then keeps the *first*
`MAX_TOOL_CONTEXT_ITEMS` (10) of those, so on a turn with more than 10 the judge never sees the 10 most
recent — usually the ones the reply rests on. Every judge path calls `fitContextForJudge`: per-criterion,
consolidated, the hallucination probe, and the usage estimate. Decide which end is meant, then make the
two agree. The `fitContextForJudge` item-limit test asserts only a length until then.
Acceptance: one end chosen and documented on `fitContextForJudge`, and a test pinning which items survive.

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
| DASH-UNDICI-OVERRIDE-MAJOR | The `undici` override holds jsdom a major version back | P4 | Pre-existing; surfaced while reviewing the `$undici` repoint. Source: session 2026-10-17 |
| DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE | Audit the seven `scripts/__tests__` judge and sync files for test quality | P3 | The magic-number sweep's review pass touched them twice in one day (`9663020`); the review checked only for semantic drift, never whether each test fails when its implementation is wrong. Source: session 2026-10-19 |

**DASH-TEST-QUALITY-AUDIT-JUDGE-SUITE.** Files: `scripts/__tests__/judge-evaluations.test.ts`,
`pipeline-integration.test.ts`, `derive-evaluations.test.ts`, `sync-prioritization.test.ts`,
`judge-hallucination-eval.test.ts`, `judge-consolidated.test.ts`, `judge-selection.test.ts`. The
magic-number sweep (666 literals named across 74 files, six agents in parallel) and its review fixes
rewrote these seven most heavily, and the read-only review hunted only for assertions that had come to
track their own source constant or lost a boundary; it ran no mutation and did not judge the tests on
their own terms. Audit each file for:
- **Contract, not internals.** Every test exercises the module's public surface and would survive a
  refactor that keeps behaviour; drop or rewrite tests pinned to private helpers or call order.
- **Three paths per behaviour.** Happy path, the boundary (caps, empty input, exact thresholds such as
  `MAX_TEXT_LENGTH`, `MIN_TRACE_BUDGET`, the 19-character turn key) and the error path each have a test
  that fails for the right reason.
- **Real collaborators.** Doubles only at the true boundaries (the LLM provider, the network, process
  exit, the clock); `createMockLLM`/`createFakeProvider` stay, incidental mocks of sibling modules go.
- **Assertions that can fail.** No expected value computed by the code under test, no `toHaveLength`
  of the result's own length, no `toBeCloseTo` where exact equality holds; one behaviour per test,
  Arrange-Act-Assert visible, names that state the behaviour (`'returns 0.5 for in_progress tasks'`
  must still say 0.5 somewhere a reader can check).
- **Fixtures earn their constants.** A hoisted `const` is justified only when a reader needs the name
  to understand the assertion; a `CLOSE_TO_DIGITS` or `OVERFLOW_CHARS` repeated across files belongs in
  `scripts/__tests__/support/`, which the sweep was told not to touch.
Acceptance: a written per-file verdict (keep / rewrite / delete per test), the rewrites landed,
`npm run test:scripts` green, and a mutation spot-check — flip one threshold or comparison in each
module under test and confirm at least one of its tests fails.

**Status (2026-10-22).** The verdict and the spot-check are written in
[`docs/reviews/2026-10-22-judge-suite-test-audit.md`](reviews/2026-10-22-judge-suite-test-audit.md):
32 mutants went from 15 to 25 killed by the seven files, and each survivor is accounted for there.
The rewrites that let a mutant through or could pass for the wrong reason have landed, and
`test:scripts` is green (872). **What remains is the review's _Remaining_ rows:**
- the `it.each` splits and `toBeCloseTo` → `toBe` changes;
- moving the derive task-completion tests onto `deriveAll`, so the test-only accumulator exports can go;
- `fitContextForJudge`'s item-limit assertion, which waits on DASH-JUDGE-CONTEXT-OLDEST-TOOL-RESULTS.

**DASH-UNDICI-OVERRIDE-MAJOR.** `jsdom@30.1.2` declares `undici: ^8.11.2`, but the root `overrides`
entry forces 7.30.0 onto every copy, so `npm ls undici` shows jsdom's edge as `deduped` to a version
its own range excludes — a major downgrade npm reports as satisfied. Dev- and test-only (jsdom is the
vitest DOM environment and nothing under `src/`, `worker/` or `scripts/` imports `undici` directly; it
is declared only so the override's `$undici` reference resolves), and the suites pass, so this is a
record rather than a defect. Two things follow from it:
- The override exists for a security floor (b21a7be, "compromised undici"), so it should not simply be
  dropped to let jsdom have 8.x. Raising it to `^8` means checking `miniflare`, whose edge is 7.29.1.
- **The `$undici` form couples the override to the devDependency.** Removing the devDependency breaks
  the reference, and bumping it moves every transitive copy with it. That is the point — it is what
  keeps one version in the tree — but it means the devDependency is load-bearing despite being
  imported nowhere. Do not "clean it up" as unused.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
