# Dashboard Backlog

Open items from code reviews and deferred work.

**Resolved items**: [v2.30 Final Review Follow-ups FR1–FR8](changelog/2.30/CHANGELOG.md) (2026-03-01) | [v2.29 DRY Backlog H1–L6](changelog/2.29/CHANGELOG.md) (2026-03-01) | [v2.28 Theme CSS DRY](changelog/2.28/CHANGELOG.md) (2026-02-28) | [DRY pages/ refactor](changelog/2.28/CHANGELOG.md) (2026-02-28)

> All 10 DRY review items (H1–H3, M4–M7, L8–L10) were implemented and committed 2026-02-28.
> See commits 7084538 and bb7f141.

> All 14 DRY backlog items (H1, H4, H5, M3–M6, M8, L1–L6) were implemented 2026-03-01 and migrated to [v2.29 changelog](changelog/2.29/CHANGELOG.md).
> Session aaf11fa follow-up; commits ea59b38–285a533.

> All 7 DRY backlog items (M1–M4, L1–L3) were implemented 2026-03-02.
> Commits d8a0098–40499b3.

**Resolved items**: [v3.0.1 H1/M1](changelog/3.0.1/CHANGELOG.md) (2026-03-06) — backfill pre-filter fix + toxic-border test stabilization.

## Open Items

### ~~H1: `--backfill` session pre-filter can skip missing metric gaps~~ [Done]

- Severity: `High`
- Introduced in: `2446f81` (`feat(judge): add --backfill flag to generate trace-based seed evaluations`)
- Primary area: `scripts/judge-evaluations.ts`
- Why this matters:
  - The `--backfill` flow is intended to fill missing seed-style evaluation metrics for sessions discovered from traces.
  - Current pre-filter logic checks only for a hallucination key and can skip a session even when other metric keys are still missing.
  - This can leave partial evaluation coverage while reporting that sessions are already covered.

#### Current behavior

- In `main()` backfill path, sessions are filtered before `seedEvaluations()`:
  - `scripts/judge-evaluations.ts` near `newTurns` filter (`sessionId:hallucination:turnKey` check).
- `seedEvaluations()` already performs per-metric idempotency checks against `existingKeys`:
  - `relevance`, `coherence`, `faithfulness`, `hallucination`, `tool_correctness`.
- Net effect:
  - If a session has `hallucination` but lacks one or more of the other metrics, it is filtered out too early and never repaired.

#### Reproduction sketch

1. Ensure existing evaluations include only `hallucination` for a trace-discovered session/turnKey.
2. Run `tsx scripts/judge-evaluations.ts --backfill`.
3. Observe the session is treated as covered and no missing metrics are emitted.

#### Root cause

- Duplicate gating at two levels with mismatched granularity:
  - Coarse pre-filter in backfill path (single metric key).
  - Fine-grained checks in `seedEvaluations()` (all relevant metric keys).
- The coarse gate prevents the fine-grained idempotent logic from executing.

#### Recommended fix

- Remove or broaden the `newTurns` pre-filter in the `--backfill` path:
  - Preferred: pass all discovered turns to `seedEvaluations()` and rely on existing per-metric checks.
  - Optional optimization: pre-filter only sessions where all relevant keys are already present (not just hallucination).
- Keep evaluator-type override (`seed` -> `trace-backfill`) unchanged.
- Keep lock-file behavior unchanged.

#### Acceptance criteria

- Running `--backfill` on a session with partial existing metrics adds only the missing metrics.
- Running `--backfill` repeatedly remains idempotent (no duplicate writes).
- Console summary reflects real additions by category.

#### Suggested tests

- Add a unit/integration test in `scripts/__tests__/judge-evaluations.test.ts`:
  - Arrange a turn with `existingKeys` containing only hallucination key.
  - Execute backfill path (or extracted helper) and assert non-hallucination seed metrics are emitted.
- Add an idempotency rerun assertion (second run emits zero new evaluations).

---

### ~~M1: Correlation toxic-border test is brittle after CSS var refactor~~ [Done]

- Severity: `Medium`
- Introduced by style constantization in commit range including `ad5f0c3`
- Primary areas:
  - `src/components/CorrelationHeatmap.tsx`
  - `src/__tests__/f1-f6-components.test.tsx`
- Why this matters:
  - Head commit testing in isolated review worktree shows one failing test in the component suite.
  - Failure is caused by a selector tied to literal inline style text (`"2px solid"`), not by broken toxic-cell behavior.
  - This creates noisy CI/local failures and obscures actual regressions.

#### Current behavior

- Component now renders toxic border via CSS variable-based value:
  - `border: var(--border-width-thick) solid ...`
- Test still asserts via string selector:
  - `container.querySelectorAll('[style*="2px solid"]')`
- Result: selector no longer matches, expected toxic cells count fails.

#### Observed evidence (isolated HEAD review run)

- Vitest in temporary detached worktree at `be0d8d9`:
  - `292 passed`, `1 failed`.
  - Failing test: `src/__tests__/f1-f6-components.test.tsx > CorrelationHeatmap > applies toxic border styling`.

#### Recommended fix

- Make test assert behavior semantically rather than style-string implementation details.
- Options (recommended first):
  - Add stable marker for toxic cells (for example `data-toxic="true"` on toxic cells) and assert count.
  - Or assert on class toggle dedicated to toxic state.
  - Or assert computed style in jsdom where reliable (less preferred than explicit marker).

#### Acceptance criteria

- `src/__tests__/f1-f6-components.test.tsx` passes without relying on exact inline border text.
- Test remains valid if border width/token changes again (for example `2px` -> CSS variable or theme token).
- No visual behavior change in toxic highlighting.

#### Suggested follow-up

- Audit nearby tests for similar brittle style-string selectors after tokenization refactors.
