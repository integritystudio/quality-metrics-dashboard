# Dashboard Backlog

Open items from code reviews and deferred work.

## Open Items

### Behaviour

No open items.

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
| DASH-LINT-PARENT-PARITY | Parent ESLint rules the dashboard does not enforce | P3 | Hit counts measured 2026-10-16; the 605 autofixable hits are swept and their 6 rules landed, plus `no-duplicate-imports`, `import/no-extraneous-dependencies`, `import/no-cycle`, `unified-signatures`, `no-unmodified-loop-condition`, `max-params` and `max-depth` by hand on 2026-10-17. 610 hits remain, none autofixable. Source: session 2026-10-12 |
| DASH-ERRORDETAIL-OPTIONAL | `ErrorDetail.tool`/`errorType` are optional but always set | P4 | Pre-existing, not from the return-type work. Source: session 2026-10-16 |
| DASH-UNDICI-OVERRIDE-MAJOR | The `undici` override holds jsdom a major version back | P4 | Pre-existing; surfaced while reviewing the `$undici` repoint. Source: session 2026-10-17 |

**DASH-LINT-PARENT-PARITY.** Diffed with `eslint --print-config` on one src, worker, scripts and test file
here against `../src/server.ts` and a parent test under the parent's `eslint.config.cjs`. The cheap subset
(`prefer-template`, `object-shorthand`, `unicorn/throw-new-error`, `unicorn/prefer-node-protocol`, strict
`restrict-template-expressions`, `vitest/no-focused-tests`, `vitest/no-identical-title`) already landed, as has
the `--max-warnings 0` gate and, on 2026-10-16, every rule whose hits `--fix` could clear.
Unless noted, each rule is missing from `src/`, `worker/` and `scripts/` alike.
- **Lint gate.** Done. `--max-warnings 0` is on `npm run lint` and `npm run lint` is a CI step
  (`.github/workflows/ci.yml`, after the parent build — it is type-aware). Landed 2026-10-16: the tree
  was already at 0 warnings over 376 files, so the gate cost nothing; the 241 warnings this entry first
  recorded were swept by the parity commits before it. `reportUnusedDisableDirectives` needs no change —
  its flat-config default is `warn`, which the gate now fails on (verified: a stale directive in
  `scripts/__tests__/judge-consolidated.test.ts` surfaced as a warning during the measurement run).
  Only `reportUnusedInlineConfigs: 'error'` is still missing; it defaults to `off`.

**Measured hits (2026-10-16).** Every rule below was run over `src/ scripts/ worker/` by layering it onto
the live config, with the plugins the dashboard does not install loaded from the parent checkout. Totals:
768 errors, 513 warnings, 376 files. `--fix` column is true autofixes; `unicorn/no-array-sort`,
`no-array-callback-reference`, `strict-void-return` and `no-promise-executor-return` offer suggestions only.

| Rule | Hits | `--fix` | src / test |
|---|---|---|---|
| ~~`@typescript-eslint/consistent-type-definitions`~~ (landed) | 261 | 261 | 218 / 43 |
| ~~`@typescript-eslint/explicit-function-return-type`~~ (46 of 253 landed) | 253 | 0 | 247 / 6 |
| ~~`@stylistic/indent`~~ (landed) | 215 | 215 | 215 / 0 |
| `local/no-magic-numbers-ignore-bitwise` (warn) | 160 | 0 | 158 / 2 |
| `unicorn/no-array-sort` | 65 | 0 | 38 / 27 |
| ~~`@typescript-eslint/dot-notation`~~ (landed) | 49 | 49 | 22 / 27 |
| ~~`@typescript-eslint/promise-function-async`~~ (landed) | 46 | 46 | 45 / 1 |
| `complexity` 12 (warn) | 39 | 0 | 36 / 3 |
| `no-await-in-loop` (warn) | 32 | 0 | 25 / 7 |
| ~~`@typescript-eslint/method-signature-style`~~ (landed) | 31 | 31 | 13 / 18 |
| `unicorn/no-array-callback-reference` | 25 | 0 | 16 / 9 |
| ~~`no-duplicate-imports`~~ (landed) | 26 | 0 | 8 / 18 |
| ~~`import/no-extraneous-dependencies`~~ (landed) | 25 | 0 | 25 / 0 |
| `sonarjs/no-duplicate-string` (warn) | 15 | 0 | 15 / 0 |
| ~~`max-params` 4~~ (landed) | 11 | 0 | 8 / 3 |
| `vitest/no-conditional-expect` | 9 | 0 | 0 / 9 |
| `@typescript-eslint/strict-void-return` | 5 | 0 | 2 / 3 |
| `regexp/no-super-linear-move` | 4 | 0 | 1 / 3 |
| `no-promise-executor-return` | 3 | 0 | 1 / 2 |
| ~~`@typescript-eslint/no-unnecessary-type-arguments`~~ (landed) | 3 | 3 | 3 / 0 |
| ~~`max-depth` 4~~ (landed) | 2 | 0 | 2 / 0 |
| ~~`no-unmodified-loop-condition`~~ (landed) | 1 | 0 | 0 / 1 |
| ~~`@typescript-eslint/unified-signatures`~~ (landed) | 1 | 0 | 1 / 0 |

**Swept and landed 2026-10-16** (the six struck rows above, 605 hits, `npm run lint --fix`). Two of the
autofixes were not behaviour-preserving and were corrected by hand — note both before re-running a sweep:
- `consistent-type-definitions` rewrites `interface X extends Base` to `{...} & Base`, which **intersects**
  a member the interface form **overrode**. Recharts types `BarShapeProps['payload']` as `any`, so
  `DailyUsageChart.tsx`'s narrowed `payload` silently widened back to `any` (caught by `no-unsafe-*`).
  Fixed with `Omit<BarShapeProps, 'payload'> & { payload?: TonedDailyUsage }`.
- `no-unnecessary-type-arguments` stripped `<Edge>` from `useEdgesState<Edge>([])` in `WorkflowGraph.tsx`.
  The argument matches the default but is load-bearing: without it the empty literal infers `never[]` and
  every `setEdges` call fails to typecheck. Restored behind a one-line disable.

**`no-duplicate-imports` landed 2026-10-17** at the parent's bare `error` (defaults:
`includeExports: false`, `allowSeparateTypeImports: false`), in `typeSafetyRules`, so `src/`, `worker/`
and `scripts/` alike. All 26 hits were the same shape — a separate `import type { … }` beside a value
import of the same module — and were merged into the value import as inline `type` specifiers. 16 of
them were `import type { FixtureServer }` under `src/__tests__`. No behaviour change: `verbatimModuleSyntax`
erases an inline `type` specifier exactly as it erases an `import type` statement.
- The option **`allowSeparateTypeImports: true` would have made all 26 pass untouched**, but it is not
  what the parent sets, and the split is the thing worth catching.
- `@typescript-eslint/consistent-type-imports` does **not** pull them back apart: its default
  `fixStyle: 'separate-type-imports'` only governs how it rewrites an *unmarked* type import, and a
  marked specifier in a mixed import satisfies it. The parent runs both rules together for the same reason.

**`import/no-cycle` and `import/no-extraneous-dependencies` landed 2026-10-17** at the parent's
settings, in one config block over `src/`, `worker/` and `scripts/`. `eslint-plugin-import-x` (the maintained fork;
`eslint-plugin-import` does not support ESLint 10) is registered under the `import` name and the
TypeScript resolver is pointed at both tsconfigs. `DEV_DEPENDENCY_FILES` mirrors the parent's list,
narrowed to the trees this package has.
- **24 of the 25 hits were the `@parent` alias, not a real finding.** `@parent/*` resolves to
  `../dist/*`, whose nearest `package.json` names the parent package, so the rule reported every
  boundary file under `observability-toolkit`. Silenced with `whitelist: ['observability-toolkit']`
  rather than by disabling the rule in those files, so they are still checked for every other package.
  The parent build output is reached by alias on purpose and must never become a dependency here.
- 🔴 **The 25th was real: `scripts/judge-anthropic-client.ts` imported `undici`, declared nowhere.**
  It reached the tree only through `jsdom` and `wrangler` → `miniflare`, so a bump of either would
  have broken the judge's HTTP/1.1 fetch at run time (the import is dynamic, so not at build time).
  Declared `undici: ^7.30.0` as a devDependency, and the pre-existing security override
  (`^7.24.4`, b21a7be, "compromised undici") repointed to `"$undici"` so it still forces one version
  on every transitive copy — npm refuses a direct dependency that conflicts with a literal override
  (`EOVERRIDE`). Verified: `npm ls undici` dedupes to a single 7.30.0.
- ⚠️ **Two silent-pass shapes in `no-extraneous-dependencies`.** An import the resolver cannot
  resolve is skipped (`if (!resolved) return` in the rule), so an uninstalled package is not a
  finding — probing with a package that does not exist proves nothing. Type-only imports are skipped
  too (`verifyTypeImports` defaults off). The rule was proved live three ways instead: an undeclared
  but resolvable package in `src/` reports `missing`, a devDependency in `src/` reports `devDep`, and
  the same import under `scripts/` is correctly silent.
- **`import/no-cycle` found zero cycles**, as predicted, and costs ~1 s on a full lint (15.6 s vs
  14.5 s wall). A clean run means nothing on its own — the extensions/parsers settings are what make
  the plugin parse `.ts` at all, and without them it builds no graph and passes silently — so the
  graph was proved real with a throwaway two-module cycle under `src/lib/`, which fired on both
  files. A type-only cycle of the same shape is correctly silent: those imports are erased, so they
  cannot TDZ. `@parent` resolves to `../dist`, which is not `node_modules`, so `ignoreExternal` does
  not exclude it and the parent build output is walked.

**`unified-signatures` landed 2026-10-17** at the parent's bare `error` (it gets the rule from
`tseslint.configs.strict`), in `typeSafetyRules`, so `src/`, `worker/` and `scripts/` alike. Test files
inherit it from the `src/`+`worker/` block.
- The single hit was `toDateOnly` in `src/api/api-constants.ts`: `(d: Date): string` and
  `(d: string): string` overloads above a `(d: Date | string): string` implementation. Both arms
  returned `string`, so the pair narrowed nothing the implementation signature does not; both were
  deleted and the implementation signature exported directly. All 13 call sites across 7 files pass a
  `Date` or a `string`, and `typecheck` + `typecheck:scripts` are unchanged.
- **The rule reports only when two signatures differ in exactly one parameter and agree on everything
  else, return type included** — so a merge it asks for is type-equivalent by construction. That does
  not generalise to collapsing overloads by hand: overloads with differing return types are
  load-bearing and the rule stays silent on them.
- Proved live three ways: it reported the real hit above before the fix, and a throwaway overload pair
  fired under both `scripts/` and `src/__tests__/`.

**`no-unmodified-loop-condition` landed 2026-10-17** at the parent's bare `error`, in `typeSafetyRules`
beside the other high-signal core rules it sits with there (`eqeqeq`, `no-self-compare`,
`no-constructor-return`). Proved live with a throwaway `while (n > 0)` under `src/` and `worker/`, on top
of the real hit below.
- 🔴 **The single hit was a false positive, and the same blind spot the file already documents.**
  `runClock` in `scripts/__tests__/judge-batch-provider.test.ts` loops on `while (!settled)`, where
  `settled` is flipped by the `done` callback in `work.then(done, done)`. Neither eslint's loop
  analysis nor TypeScript's flow analysis follows a mutation through a callback reference, so the
  line already carried a `no-unnecessary-condition` disable for the identical reason; the new rule
  joined it rather than the loop being restructured. The loop is correct —
  `vi.advanceTimersByTimeAsync` drains microtasks, so `done` runs.
- So this rule's value here is **future** code, not a defect it found. Expect the same false positive
  from any `while (!flag)` whose flag a callback sets, and prefer extending the existing disable to
  rewriting a correct loop.

**`max-params` 4 and `max-depth` 4 landed 2026-10-17** at the parent's levels, in a `Complexity controls`
block over `src/`, `worker/` and `scripts/` — the home the remaining complexity rules (`complexity` 12,
`no-await-in-loop`, `sonarjs/no-duplicate-string`) should join. Proved live with a throwaway 5-parameter
function and a 5-deep `if` nest under `src/`, `worker/`, `scripts/` and both test trees: all 10 hits fired.
All 13 real hits were fixed by hand (11 `max-params`, 2 `max-depth`); `--fix` offers nothing for either.
- **The parent's `warn` is this repo's `error`.** Both rules are `warn` there, and that severity was kept
  for parity, but `npm run lint` runs under `--max-warnings 0` — so there is no "adopt at warn and defer
  the hits" option here. Every hit had to go before the rule could land, which is what makes the
  remaining `complexity`/`no-await-in-loop`/`no-duplicate-string` rows (86 hits) a sweep, not a flag flip.
- 🔴 **`exactOptionalPropertyTypes: true` breaks the obvious `max-params` fix.** Grouping optional
  parameters into an object type is the standard remedy, but `spans?: boolean` no longer accepts a
  caller's `boolean | undefined` variable: as a separate argument it was an omitted one, and as a
  property it is a present `undefined`. Each grouped optional property must be spelled
  `?: T | undefined` (`computeDataSources`'s `Truncation`, `computeLayout`'s `LayoutOptions`). `tsc`
  catches it, so this costs a round trip rather than correctness — expect it on every future grouping.
- **`max-depth` counts statements, not braces**: eslint pushes a level for each `if`/`for`/`while`/`try`
  whether or not it is braced, so dropping the braces around a single statement does not help. Both hits
  were real nesting — `readJsonlWithValidationSync`'s per-line `if (result.success) { … }` became an
  inverted `continue` guard, and `upload-evaluations`'s skip branch moved its inner `if` into a
  `recordSkip` helper. `main` there is already `try` → `for file` → `for line`, so any new conditional in
  that loop starts at depth 4 and has one level of headroom.
- The `max-params` fixes were parameter grouping, not signature shuffling, so each one is visible at the
  call sites: `createEvalRecord(turn, {…})` (7 → 2, and the OBP16 comment now says "separate fields"),
  `queryEachAccount(env, spec, query)` (`AccountQueryLabel` grew into `AccountQuerySpec` with the limit
  and log prefix it was always passed beside), `summarizeJudgeRun(succeeded, { byMetric, byClass }, …)`
  (20 test call sites), and `evaluateTurnConsolidated(…, { stepsCache, criteria })`.

`@stylistic/eslint-plugin` was added as a devDependency for `@stylistic/indent`.
`promise-function-async` is off in test files, matching the parent's block and its reasoning (async stubs
for Promise-returning interfaces); with it on there it fires 154 extra times.

**`explicit-function-return-type` is on for `src/api`, `src/hooks` and `src/lib` only** (landed
2026-10-16, at `error`; the parent has it tree-wide at `warn`). 46 sites annotated there. It is
deliberately **not** applied to `src/components` or `src/pages`, which hold 156 of the 235 `src/` hits:
only 3 of 127 `.tsx` files import React and the codebase has no `JSX.Element` annotation anywhere, so
adopting it there means adding `import type { JSX } from 'react'` to ~120 files to satisfy the linter.
Revisit only if those imports become wanted for another reason. What the 46 cost:
- `src/hooks` (20): every hook returns `UseQueryResult<T>`. Write it **without** the `Error` argument —
  it is the default `TError`, and spelling it trips `no-unnecessary-type-arguments`.
- `src/api/session-detail.ts` (15): its `compute*` helpers returned anonymous object shapes, so the file
  gained named exported types (`DataSources`, `SessionInfo`, `TokenMetrics`, `SessionDetail<M, E>`, …).
  That is the bulk of the work and the main reason the rule is not free.
- `src/api/data-loader.ts` + `routes/sessions.ts` (4): the trace loaders return
  `Promise<LoadedSpan[]>`, where `LoadedSpan = Awaited<ReturnType<typeof queryTracesTool>>['traces'][number]`.
  **They were annotated `Promise<TraceSpan[]>` first, and that was wrong** — see the hazard below.
- Two exemptions, both documented in place: `queryValidator` (hono's `validator` returns a
  ~1500-character conditional type that cannot be restated; approximating it erases
  `c.req.valid('query')`'s typing) carries a disable, and `validQuery` borrows it exactly with
  `ReturnType<typeof queryValidator<T>>` rather than restating it.

🔴 **Hazard for the remaining sites: a return type WIDER than the inferred one compiles silently.**
Nothing catches it — not `tsc`, not the rule, not the tests. Annotating the trace loaders
`Promise<TraceSpan[]>` looked right and passed everything, but `queryTraces` projects nine fields (the
`traces: traces.map(…)` projection in the parent's `src/tools/query-traces.ts`) while `traceSpanSchema`
carries eight more optional ones (`orgId`, `parentSpanId`, `statusCode`, `events`, `links`,
`instrumentationScope`, `traceFlags`, `traceState`). The annotation made reading any of them compile and return `undefined`, where it had been
a compile error. Fixed in ec83910 by **deriving** the type from the producer rather than naming a
hand-picked one, so the two cannot drift. Prefer `Awaited<ReturnType<typeof f>>` / `Pick<…>` over naming
a type that merely looks like the right one, and when naming one, check the producer's field list.
Two annotations in the 2026-10-16 autofix sweep had the same shape of defect
(`DailyUsageChart.tsx`, `WorkflowGraph.tsx`, recorded above).

**Follow-on dedupe (b892da8, 07f7e0d, 93676cd).** Naming `session-detail.ts`'s shapes exposed that
`src/hooks/useSessionDetail.ts` restated eleven of them — seven byte-identical (`SessionInfo`,
`TokenTotals`, `FileAccessEntry`, `GitCommit`, `CodeStructureEntry`, `AlertSummary`, `Timespan`) and four
identical under another name (`TokenSnapshot`≡`TokenProgressionEntry`, `HookLatency`≡`HookLatencyEntry`,
`SessionAgentStat`≡`AgentActivityEntry`, `EvaluationBreakdownEntry`≡`EvalBreakdownEntry`), each pair
confirmed property-by-property with the type checker before deleting. All eleven now
come from `src/api/session-detail.ts`; the import is type-only, so none of `src/api`'s Node-only code
reaches the bundle (verified: `api-constants` appears 0 times in `dist/assets/*.js`). The hook exports
only `DataSources`, `SessionDetailResponse` and `useSessionDetail` now — the earlier re-export block was
removed because nothing imported it, and `org-kv-entries.ts` already takes `AgentActivityEntry` straight
from the canonical module.

⚠️ **`DataSources` is deliberately NOT shared** — do not "finish" this dedupe. The API's version describes
what the writer emits (`TruncationFlag` = `{ truncated: true } | { truncated?: never }`); the hook's
describes what a reader may receive, which includes `truncated: false` from a producer that writes the
flag either way. Sharing it breaks the `is false` case in `SessionDetailPage.test.tsx`. The rationale is
in a comment on the type itself.

**Free today — zero hits, adoptable with no sweep:** `no-eval`, `no-new-func`, `no-unreachable`, `no-unreachable-loop`,
`unicorn/prefer-number-properties`, `@typescript-eslint/prefer-readonly`, `no-useless-constructor`,
`no-useless-default-assignment`, `no-non-null-asserted-nullish-coalescing`, `vitest/no-disabled-tests`,
`vitest/expect-expect`, `vitest/valid-expect`, and both option-drift changes
(`no-deprecated` warn → error, `ban-ts-comment` `minimumDescriptionLength: 10`).
- **Magic numbers.** `local/no-magic-numbers-ignore-bitwise` (warn) and, in tests,
  `local/no-magic-numbers-ignore-fixtures`. The rule is defined inline in the parent's CJS config and not
  exported, so it must be extracted into a shared module or copied.
- **Complexity.** `complexity` 12, `no-await-in-loop`, `sonarjs/no-duplicate-string` (all warn);
  ~~`max-depth` 4~~ and ~~`max-params` 4~~ landed 2026-10-17.
- **Imports.** Done — `import/no-cycle` and `import/no-extraneous-dependencies` both landed
  2026-10-17.
- **Formatting.** `@stylistic/indent` 2, `SwitchCase: 1`.
- **Core.** `no-eval`, `no-new-func`, `no-promise-executor-return` (source only), `no-unreachable-loop`,
  ~~`no-unmodified-loop-condition`~~ (landed 2026-10-17), `no-unreachable` (off here via tseslint's
  `eslint-recommended`).
- **unicorn.** `no-array-sort`, `no-array-callback-reference`, `prefer-number-properties` (partly covered here by
  `no-restricted-globals` and `radix`).
- **regexp.** `regexp/no-super-linear-move`.
- **TypeScript.** `dot-notation`, `explicit-function-return-type` (warn), `method-signature-style: property`,
  `consistent-type-definitions: type`, `prefer-readonly`, `no-unnecessary-type-arguments`,
  `no-useless-default-assignment`, `promise-function-async` and `strict-void-return` (source only); from the
  `strict` preset ~~`unified-signatures`~~ (landed 2026-10-17), `no-useless-constructor`,
  `no-non-null-asserted-nullish-coalescing`.
- **Option drift.** `no-deprecated` is `error` there, `warn` here; `ban-ts-comment` wants
  `minimumDescriptionLength: 10`; `no-unused-vars` here also exempts `_`-prefixed destructured array elements.
  Keep `scripts/`' `prefer-nullish-coalescing` `ignorePrimitives: { boolean: true }`: it guards the
  `isDirectRun` checks.
- **Tests only.** `vitest/no-disabled-tests`, `expect-expect`, `no-conditional-expect`, `valid-expect` (`maxArgs: 2`);
  `no-unnecessary-type-assertion` stays off here on purpose (see the comment in `eslint.config.mjs`).

New devDependencies: `@stylistic/eslint-plugin`, `eslint-plugin-import-x` and
`eslint-import-resolver-typescript` (all three installed), plus `eslint-plugin-sonarjs` still to come,
at the parent's versions; the dashboard installs standalone in CI.

Acceptance: re-running the `--print-config` diff lists no parent rule absent here except the documented
exclusions, and `npm run lint` exits 0 under `--max-warnings 0`.

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

**DASH-ERRORDETAIL-OPTIONAL.** `src/api/session-detail.ts` `ErrorDetail` declares
`tool?: string; errorType?: string`, but `computeErrorSummary` sets both on every pushed entry, each with
a `?? 'unknown'` fallback, so neither is ever absent. Every consumer handles an `undefined` that cannot
happen. The optionality predates the return-type work (it was already in the local
`Array<{ … }>` annotation at `dcc09af:session-detail.ts:270`); extracting the named type copied it
faithfully rather than introducing it. Tightening it to required also means tightening the mirrored
`errors.details` in `src/hooks/useSessionDetail.ts`, which is why it was left alone. Type-only — the KV
value and the wire payload do not change.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
