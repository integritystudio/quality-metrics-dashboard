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
| DASH-LINT-PARENT-PARITY | Parent ESLint rules the dashboard does not enforce | P3 | Hit counts measured 2026-10-16; the 605 autofixable hits are swept and their 6 rules landed, plus `no-duplicate-imports`, `import/no-extraneous-dependencies`, `import/no-cycle`, `unified-signatures`, `no-unmodified-loop-condition`, `max-params`, `max-depth`, `vitest/no-conditional-expect`, `no-promise-executor-return` and `regexp/no-super-linear-move` by hand on 2026-10-17 and `strict-void-return`, `unicorn/no-array-callback-reference`, `no-await-in-loop`, `unicorn/no-array-sort`, `complexity` 12 and `sonarjs/no-duplicate-string` on 2026-10-18, with `local/no-magic-numbers-ignore-bitwise` enabled at warn for non-test files the same day and swept from 155 hits to 0. The 12 zero-hit rules, both option-drift changes and `reportUnusedInlineConfigs: 'error'` landed 2026-10-19. Still open: the `no-unused-vars` option drift and the magic-number follow-ups; 207 `explicit-function-return-type` hits over `src/components`/`src/pages` stay excluded on purpose (see below). Source: session 2026-10-12 |
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
  `reportUnusedInlineConfigs: 'error'` (default `off`) landed 2026-10-19 at 0 hits; a redundant
  `/* eslint prefer-template: "error" */` probe failed lint as expected.

**Measured hits (2026-10-16).** Every rule below was run over `src/ scripts/ worker/` by layering it onto
the live config, with the plugins the dashboard does not install loaded from the parent checkout. Totals:
768 errors, 513 warnings, 376 files. `--fix` column is true autofixes; `unicorn/no-array-sort`,
`no-array-callback-reference`, `strict-void-return` and `no-promise-executor-return` offer suggestions only.

| Rule | Hits | `--fix` | src / test |
|---|---|---|---|
| ~~`@typescript-eslint/consistent-type-definitions`~~ (landed) | 261 | 261 | 218 / 43 |
| ~~`@typescript-eslint/explicit-function-return-type`~~ (46 of 253 landed) | 253 | 0 | 247 / 6 |
| ~~`@stylistic/indent`~~ (landed) | 215 | 215 | 215 / 0 |
| ~~`local/no-magic-numbers-ignore-bitwise`~~ (landed at warn for non-test files 2026-10-18; measured that day, swept to 0) | 155 | 0 | 155 / excluded |
| ~~`unicorn/no-array-sort`~~ (landed) | 65 | 0 | 38 / 27 |
| ~~`@typescript-eslint/dot-notation`~~ (landed) | 49 | 49 | 22 / 27 |
| ~~`@typescript-eslint/promise-function-async`~~ (landed) | 46 | 46 | 45 / 1 |
| ~~`complexity` 12~~ (landed) | 39 | 0 | 36 / 3 |
| ~~`no-await-in-loop`~~ (landed) | 32 | 0 | 25 / 7 |
| ~~`@typescript-eslint/method-signature-style`~~ (landed) | 31 | 31 | 13 / 18 |
| ~~`unicorn/no-array-callback-reference`~~ (landed) | 25 | 0 | 16 / 9 |
| ~~`no-duplicate-imports`~~ (landed) | 26 | 0 | 8 / 18 |
| ~~`import/no-extraneous-dependencies`~~ (landed) | 25 | 0 | 25 / 0 |
| ~~`sonarjs/no-duplicate-string`~~ (landed) | 15 | 0 | 15 / 0 |
| ~~`max-params` 4~~ (landed) | 11 | 0 | 8 / 3 |
| ~~`vitest/no-conditional-expect`~~ (landed) | 9 | 0 | 0 / 9 |
| ~~`@typescript-eslint/strict-void-return`~~ (landed; 40 under typescript-eslint 8.71.2, see below) | 5 | 0 | 2 / 3 |
| ~~`regexp/no-super-linear-move`~~ (landed) | 4 | 0 | 1 / 3 |
| ~~`no-promise-executor-return`~~ (landed) | 3 | 0 | 1 / 2 |
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

**`vitest/no-conditional-expect` landed 2026-10-17** at the parent's bare `error`, in the `TEST_FILES`
block beside `no-focused-tests` and `no-identical-title`. Proved live with a throwaway `if (x > 0) expect(…)`
under `src/__tests__/`, `src/lib/*.test.ts`, `worker/__tests__/` and `scripts/__tests__/`: all four fired,
so the rule reaches every tree `TEST_FILES` names, not just the two files that happened to hit it.
All 9 hits were in `scripts/__tests__/{judge-evaluations,pipeline-integration}.test.ts` and all were the
same shape — a `for` over seeded evals with a per-metric `if (ev.evaluationName === …)` inside.
- 🔴 **The rule found a real vacuous pass, not a style nit.** `non-canary scores are within expected
  ranges` asserted nothing about a metric `seedEvaluations` stopped emitting: deleting `coherence` from
  `SEED_METRICS` left that test **green** (other tests caught the mutation; that one did not). The
  rewrite asserts the set of banded metrics is present *before* checking the bands, and fails.
- **The fix shape is a list of violations, not more branches.** The band test builds a `bands` table of
  `[name, low, high]`, then asserts `expect(missing).toEqual([])` and `expect(outOfBand).toEqual([])`,
  each list built with `filter`/`flatMap` and formatted `name=score` so a failure names the metric and
  the offending value — which the old `expect(ev.scoreValue).toBeGreaterThanOrEqual(0.70)` inside a loop
  did not. The canary test has one assertion per metric and so filters raw score arrays inline; the
  failing line is what identifies the metric there.
- 🔴 **Assert the complement, because NaN fails every comparison.** `score < low || score > high` is
  **false** for NaN, so the positive form lets a NaN through both arms; `!(score >= low && score <= high)`
  catches it. The same hole sank the first canary rewrite, which used `d3-array`'s `max`/`min`: those
  **skip** NaN, so a partially-NaN series passes. Measured — a producer emitting NaN for a subset of
  relevance scores passed all 128 tests in `judge-evaluations.test.ts` before this and reds two after.
  The pre-existing `expect(ev.scoreValue).toBeGreaterThanOrEqual(low)` form had the same hole, so the
  rule did not introduce it; the rewrite is where it got closed. Both tests now assert `toEqual([])`
  over a `filter` of the negated predicate.
- **`Math.max(...xs)` is banned here** by `no-restricted-syntax` (stack overflow on large arrays; use
  `d3-array`) — which is what pushed the first attempt onto d3 and into the NaN hole above. The current
  shape needs neither, so the import is gone. Keep `expect(scores.length).toBeGreaterThan(0)` regardless:
  a `filter` over an empty array is `[]`, which passes.
- Verified by mutating the producer four ways — relevance's normal band widened, `coherence` dropped from
  `SEED_METRICS`, relevance's canary band raised, `CANARY_TURN_RATE` set to 0 — each one reds exactly the
  rewritten test(s) that should catch it.
- **Untested gap, left alone deliberately.** `SEED_METRICS` bands `faithfulness` (normal
  `{ min: 0.0, max: 0.09 }`, canary `{ min: 0.50, max: 0.80 }`, shared with hallucination) and
  `tool_correctness` (`{ min: 0.75, max: 1.0 }` / `{ min: 0.10, max: 0.30 }`), and no test pins either. Adding them is coverage work, not part of adopting the rule.

**`max-params` 4 and `max-depth` 4 landed 2026-10-17** at the parent's levels, in a `Complexity controls`
block over `src/`, `worker/` and `scripts/` — `no-await-in-loop` joined on 2026-10-18, and `complexity` 12
and `sonarjs/no-duplicate-string` closed the group the same day. Proved live with a throwaway 5-parameter
function and a 5-deep `if` nest under `src/`, `worker/`, `scripts/` and both test trees: all 10 hits fired.
All 13 real hits were fixed by hand (11 `max-params`, 2 `max-depth`); `--fix` offers nothing for either.
- **The parent's `warn` is this repo's `error`.** Both rules are `warn` there, and that severity was kept
  for parity, but `npm run lint` runs under `--max-warnings 0` — so there is no "adopt at warn and defer
  the hits" option here. Every hit had to go before the rule could land, which is what makes the
  `complexity`/`no-duplicate-string` rows (54 hits) a sweep, not a flag flip.
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

**`complexity` 12 and `sonarjs/no-duplicate-string` landed 2026-10-18** at the parent's levels (both
`warn`, so both fatal here), closing the Complexity group. 39 + 15 hits, none autofixable;
`eslint-plugin-sonarjs@^4.2.2` matches the parent. Every complexity fix was extraction — no signature
changed except by parameter grouping, and no behaviour with it.
- 🔴 **`sonarjs/no-duplicate-string` must be switched off by `ignores`, not by a later block.** The
  parent turns it off in its test block, which is the **last** block in its config; here the
  `TEST_FILES` block comes *before* the complexity block, so putting the rule there re-enabled it in
  every test tree and the count went from 15 to **132** (11 in `sync-org-entries.test.ts` alone —
  fixture ids, exactly what the parent exempts). It now lives in its own block with
  `ignores: TEST_FILES`, so the result cannot depend on block order. A future re-measure that reports
  132 is this ordering fault, not drift.
- **Where the 15 duplicate strings were.** Nine were permission strings in `src/lib/org-rbac.ts`,
  which now exports a named `PERMISSION` map plus `VIEW_TAB_READS`/`DATA_READS`; `worker/index.ts`'s
  **25** permission literals read through it, so a permission rename is one edit instead of 26. The
  rest: each judge script's log prefix (now `LOG_PREFIX`, as `judge-batch-provider` already had) and
  `'network error'` as the status fallback in four worker log lines (`NO_RESPONSE_STATUS`).
- ⚠️ **A defaults mapper's complexity is its column count.** `fixture-server.ts`'s `evalToWire` (14)
  and `spanToWire` (18) branched only through one `?? default` per wire column. Both are now a
  `*_WIRE_DEFAULTS` constant plus a spread of the fields the input actually supplies. The helper's
  return type is load-bearing: `Partial<T>` leaves `undefined` in the spread result (`timestamp_ns:
  string | undefined` then fails to assign), so it returns `{ [K in keyof T]?: Exclude<T[K], undefined> }`.
- 🔴 **The worker's auth middleware (46) could not be split until it became `factory.createMiddleware`.**
  `app.use('/api/*', async (c, next) => …)` types `c` as `Context<AppEnv, '/api/*', any>`, so passing it
  to a helper taking `AppContext` is `no-unsafe-argument` at every call site. `factory.createMiddleware`
  (already used by `requireOrgAdmin`) gives a context without the `any`; the registration stays
  `app.use('/api/*', authenticate)` in the same position. A middleware helper must also leave its return
  type inferred — an explicit `Promise<Response | void>` trips `no-invalid-void-type`.
- **An extracted guard that returns `Response | T` keeps every error body byte-identical.** No
  `HTTPException`, no `onError` path: the caller narrows with `instanceof Response`. Where the caller
  then needs a narrowed union member (`delivery.destination`), the helper has to be a type predicate
  (`isSendable`) — a plain boolean leaves the union unnarrowed and `tsc` rejects the property read.
- ⚠️ **Hoisting the shared `AbortSignal` would have moved a deadline.** The auth middleware's one
  `AbortSignal.timeout(AUTH_TIMEOUT_MS)` is documented as covering "all auth fetches" but is never
  passed to `jwtVerify`, so the JWKS round trip already eats into the Supabase budget. It stays at its
  original position rather than moving down beside `db(c.env)`, which would have silently widened the
  DB budget by the JWKS time.
- **A `Record` over a union is the exhaustiveness check a `switch` needed a `default` for.**
  `adaptiveScoreColorBand` (17) is now one bander per `ScaleStrategy` in `BAND_BY_STRATEGY`, so a new
  strategy fails to compile until it is listed — which the old `default:` arm hid. Safe because
  `METRIC_SCALE_STRATEGY` is `Record<string, ScaleStrategy>` and the lookup already falls back to
  `'uniform'`; `noUncheckedIndexedAccess` adds no `| undefined` to a literal-keyed `Record`.
- **The two largest were structural, not clever.** `SessionDetailPage` (67) became one `sessionView`
  derivation plus twelve section components, each taking the view model and destructuring what it
  needs, so every JSX body moved unchanged. `sync-to-kv`'s `main` (46) became seven phase functions
  (`computeAllOrgs`, `buildMetaEntries`, `refreshHeartbeatOnly`, `pruneStaleKeys`, `writeCoverage`,
  `writeScopeCounter`, `logRunStart`), and `upload-evaluations`' `main` (39) and `mapRecord` (40) a
  `RunState` record plus `classifyLine`/`processFile` and `readCore`/`buildPayload`.
- **Several extractions sat at exactly 12 before a second split.** `complexity` errors *above* 12, so
  12 passes — but a function left at the limit fails on the next conditional added to it. Where that
  happened (`accumulateSpans`, `classifyLine`, `main` in `upload-evaluations`, `judgeVerdict`) one more
  helper came out: `bumpDailyCount`, `manifestMatch`, `readOptions`/`effectiveMaxAgeMs`,
  `isSuccessRateDrop`.

`@stylistic/eslint-plugin` was added as a devDependency for `@stylistic/indent`.
`promise-function-async` is off in test files, matching the parent's block and its reasoning (async stubs
for Promise-returning interfaces); with it on there it fires 154 extra times.

**`no-promise-executor-return` and `regexp/no-super-linear-move` landed 2026-10-17** at the parent's
settings — the first in `typeSafetyRules` (so `src/`, `worker/` and `scripts/`) and `off` in the test
block, the second layered onto the `regexp` recommended preset, which does not enable it. All 7 hits
were fixed by hand; neither rule autofixes, and both only ever offered suggestions. Proved live with
throwaway violations in `src/`, `worker/`, `scripts/` and all three test trees: the regexp rule fired in
every one, the executor rule in the source trees only, as configured.
- **`no-promise-executor-return` is `off` in tests for the parent's reason** — `new Promise(r =>
  setTimeout(r, ms))` is the sleep idiom — so it shares the comment already on
  `promise-function-async` there. All three hits were the same shape: a concise arrow whose body
  *expression* returns a value the executor discards (`setTimeout`'s `Timeout`, `server.listen`'s and
  `server.close`'s `Server`). A block body is the whole fix; `allowVoid` is off here as there.

**`@typescript-eslint/strict-void-return` landed 2026-10-18** at the parent's bare `error`, in
`typeSafetyRules` (so `src/`, `worker/` and `scripts/`) and `off` in the `TEST_FILES` block, as the
parent has it. Verified per tree with `eslint --print-config`: `2` for a `src/`, `worker/` and
`scripts/` file, `0` for a file in each of the three test trees.
- **The 5-hit count above is stale — it is 40 under typescript-eslint 8.71.2** (measured 2026-10-18,
  vs 8.4x when the table was written; the rule has widened since). 39 of the 40 are in test trees,
  all under `TEST_FILES`, so turning it off there — the parent's own choice, because
  `mockImplementation(() => value)` and `act(() => render(...))` return into a void slot by
  construction — left exactly one site to fix.
- **The one source hit was an `&&` guard in a JSX handler**: `onClick={() => hasLinks &&
  setExpanded(...)}` in `src/components/AgentActivityPanel.tsx` returns `false | void`. A block body
  with an `if` is the whole fix. The rule offers suggestions only, never an autofix.
- **`TEST_FILES` now includes `scripts/__tests__/**/*.ts`.** It had matched only `*.test.ts` there,
  despite the block's comment claiming it covers "support modules the src/ test override misses" — so
  the identical executor shape was an error under `scripts/__tests__/support/` and silent under
  `src/__tests__/support/`, where `fixture-server.ts` carries two of them. The split was the defect, not
  either half of it. Widening it also hands that tree the block's other exemptions, and the enforcement
  they give up there is **nothing today**, measured rule by rule: `explicit-function-return-type` was
  never on for `scripts/` at all (it is scoped to `src/api`, `src/hooks`, `src/lib`), and
  `promise-function-async`, `no-non-null-assertion` and `restrict-template-expressions` at its strict
  options each report zero hits over `scripts/__tests__/support/`. The three `vitest/*` rules the block
  adds are inert there — support modules declare no tests. Re-measure before adding a module to that
  tree that the exemptions would cover.
- **The accidental returns were swept anyway, the sleep idiom was not.** Of the 11 sites the rule would
  flag across the test trees, 10 are `new Promise(r => setTimeout(r, ms))` — the idiom the exemption
  exists for — and were left alone. The 4 that were a discarded value rather than an idiom now use block
  bodies: `fixture-server.ts`'s `listen` and `close` — plumbing both test servers had spelled out
  separately, and which now comes from one `listenLoopback` helper beside the fixture server, as do
  their statuses, header name and media types (`src/lib/http-constants.ts`, where one server had named
  them privately while the other wrote the same values inline) —
  plus `page-harness.tsx`'s never-settling fetch stub and `judge-evaluations.test.ts`'s deferred-LLM
  registration, which returned `Array.prototype.push`'s new length.
- **`src/lib/http-constants.ts` is now the one status and media-type home for `src/`.** Moving it out of
  `src/__tests__/support/` put it beside `src/lib/constants.ts`, which already exported an `HttpStatus`
  const enum with three of the same codes — two competing definitions in one directory. `constants.ts`
  lost the enum, `http-constants.ts` gained the five codes `src/` uses beyond it (200, 201, 401, 403,
  504) as a plain object. 16 `src/` files traded 28 private `HTTP_*` constants for imports, 10 more
  repointed an existing `HttpStatus` import, and 13 inline media-type literals — 10 of them
  `'Content-Type': 'application/json'` — became `CONTENT_TYPE_HEADER`/`ContentType`. The object is not
  an enum, so `no-unsafe-enum-comparison` no longer needs `useApiQuery`'s widening alias, but a parameter whose
  default is one of its members infers the literal type and needs an explicit `: number`
  (`fake-gateway.ts`'s `json`). Left alone deliberately: `worker/index.ts` and
  `worker/__tests__/support/http.ts` (the twins), and `scripts/`' own 15 constants across 5 files.
  Both were folded in afterwards — see the next entry.
- **The worker twins were convention, not a boundary.** The documented reason for `worker/index.ts`
  keeping its own `Http` object was that it "cannot safely import this package's constants", and that
  reason is about *dependencies*, not location: `src/lib/constants.ts` pulls in date-fns and zod,
  `api-constants.ts` is Node-only, but `http-constants.ts` imports nothing — and the worker already
  reached it transitively through `postgrest-client.ts`. So the local `Http` (8 members, 75 call sites)
  and the 12-member twin in `worker/__tests__/support/http.ts` both went; that support module now holds
  only `jsonResponse`, and its 14 importers take `HttpStatus` from `src/lib/` directly. `scripts/`
  followed: 15 status constants across 6 files, plus `NDJSON_CONTENT_TYPE` and `JSON_CONTENT_TYPE`,
  which were the same named-here/inline-there split the test servers had. The shared file grew the five
  codes those trees needed (204, 413, 429, 502, 503) and a `ContentType.Ndjson`.
- 🔴 **A bare `'Content-Type'` → `CONTENT_TYPE_HEADER` rewrite in an object-key position type-checks and
  is wrong.** `headers: { CONTENT_TYPE_HEADER: 'text/html' }` sends a header literally named
  `CONTENT_TYPE_HEADER`; `HeadersInit` is `Record<string, string>`, so nothing complains. It needs
  computed-key brackets. Caught in `spa-fallback.test.ts` by reading the diff, not by a failing test —
  the assertion downstream only checked that the served type was HTML.
- **`npx wrangler deploy --dry-run --outdir <tmp>` is the only check that proves the worker bundles a new
  cross-tree import.** Vitest resolves `worker/index.ts` through vite, not through wrangler's esbuild, so
  a green `npm test` says nothing about the deploy. Never run `npm run build` to check a worker change:
  it overwrites `dist/` with whatever Auth0 config the current env holds, and the next `wrangler deploy`
  uploads that `dist/` as the SPA.
- 🔴 **`e2e/` is checked by nothing but a Playwright run.** It is absent from the root `tsconfig.json`'s
  `include` (`["src", "worker", "../dist"]`) and from `npm run lint` (`src/ scripts/ worker/`), so an
  edit there cannot fail a typecheck or a lint. To type-check it, write a throwaway config extending the
  root one with `"include": ["e2e", "src", "worker", "../dist"]` **inside the repo** — from outside,
  `types` cannot resolve and it fails with `TS2688 Cannot find type definition file for
  '@cloudflare/workers-types'`. Two pre-existing errors in `navigation.spec.ts` (`timeout` not in
  `TestDetails`) are the baseline. The 26 status literals and 4 media-type sites there now import from
  `src/lib/http-constants.ts` as well; `'Access-Control-Allow-Headers': 'Authorization, Content-Type'` in
  `admin-customers.spec.ts` was left alone, being a comma-joined CORS value rather than a header name.
- **The chromium e2e suite needs the cloud pair exported, not `doppler run`.** Without
  `OBTOOL_API_URL`/`OBTOOL_API_KEY` the local API answers `/api/health` with
  `401 Missing or invalid Authorization header`, Playwright's health gate never opens, and the run dies
  with `Timed out waiting 30000ms from config.webServer` — which reads like a broken spec. Export both
  from `doppler secrets get … --plain -c dev` first; `--config dev` gives the documented 36 passed /
  7 skipped, since the data-coupled specs skip on an empty dev window.
- **The integration suite is 20 passed / 3 failed / 1 skipped on dev, and all three failures predate the
  constants work** (proved by re-running them against the pre-change spec). None is an ordering or
  substitution fault:
  - `GET /api/health returns 200 without auth` fails on the *next* line, `toHaveProperty('status', 'ok')`
    receiving `no_data` — the empty dev KV, which only `services/e2e/scripts/seed-dev.ts` fills. The
    chromium specs skip on `hasData: false`; this one has no such guard.
  - the two `/api/admin/{users,roles}` tests assert 403 "because the test user has a dashboard.read role,
    not dashboard.admin". That is no longer the gate: `worker/index.ts`'s `requireGlobalAdmin` reads
    `isOrgScopingEnabled(c.env) ? session.isStaff === true : hasPermission(session, 'dashboard.admin')`,
    and `[env.dev]` sets `ORG_SCOPING_ENABLED = "true"`. The dev test user is
    `71226e17-8969-4699-bb77-836ca2351ecf`, **the first id in `[env.dev]`'s own `STAFF_USER_IDS`**, so 200
    is correct and the assertions are stale. Fixing them means deciding what a non-staff dev user is, not
    changing the worker.
- **Teardown's `users` delete cannot succeed on dev and that is fine.** The row is referenced by an
  `api_keys` row named `e2e-l1059-provision` (created 2026-09-28, unrevoked, a different org) left by the
  provisioning e2e, so the delete returns Postgres `23503`. It used to print
  `users cleanup failed: … violates foreign key constraint "api_keys_user_id_fkey"`, which read as a
  cleanup bug; the delete order (`user_roles` → `user_activity` → `users`) was already right. Teardown now
  reports the kept row and says so in its summary line instead of claiming it cleaned the user. Deleting
  the referencing rows to force it through is the wrong fix — this suite never issued that key.
- 🔴 **`/^\s*…/m` is the super-linear shape to watch for, and it reads as correct.** Three of the four
  regexp hits were `expect(source).toMatch(/^\s*<Route …/m)` in `coverage-tab.test.tsx`: under `m`,
  `\s` matches the line break that `^` is anchored to, so the quantifier can start at every position
  (the rule names the attack string `/[\n\r\u2028\u2029]+/`). `[ \t]*` is both the fix and what
  "leading indentation" actually means — use it in any anchored multiline source scan.
- The fourth was `.replace(/\/+$/, '')` in `postgrest-client.ts`, the ordinary trailing-slash strip.
  `(?<!\/)` pins the match to the first slash of the run, so each other start position fails the
  lookbehind in O(1) instead of re-running the quantifier. Behaviour is identical on every input,
  including an all-slash string.

**`unicorn/no-array-callback-reference` landed 2026-10-18** at the parent's bare `error`, in
`typeSafetyRules` and with **no test exemption**, matching the parent — it is absent from that repo's
`TEST_FILES` block, so the dashboard enforces it in `src/`, `worker/`, `scripts/` and every test tree
alike. Proved live with a throwaway `xs.map(Math.abs)` in ten directories — the three source trees, all
three `__tests__/` roots, all three `__tests__/support/` dirs and a co-located `src/lib/*.test.ts` — and
all ten fired. All 25 hits were fixed by hand (16 source, 9 test); the rule only ever offers suggestions.
- **None of the 25 was a live defect**, and that was checked rather than assumed: every callback is
  single-parameter (`optionName`, `toOTelRecord`, `turnKey`, `envelope`, `isTraceKey`, `snapshotToEvalRow`,
  `projectEvaluationRow`, `convert`, `isStrategyGroup`, `spanLine`, `withoutOperation`, `answer`,
  `promptOf`, `entry`, `fingerprint`, `readPosition`) or ignores extra arguments (`Number.isFinite`), so
  every wrap is behaviour-preserving. The rule's value here is future code — the `xs.map(parseInt)` shape
  the parent's comment names.
- **The 9 test hits were all fixture builders passed by name** across
  `scripts/__tests__/{account-stamps,derive-evaluations,judge-consolidated-batch,kv-bulk,upload-evaluations}.test.ts`
  and `src/__tests__/WorkflowGraph.test.tsx`. Adopting the rule there costs the 9 wraps and nothing else:
  both suites are unchanged at 1209 and 844 passing.
- 🔴 **The rule already exempts a type guard on `every`/`filter`/`find`/`findLast`, so do not "fix" one by
  wrapping it.** `methodsWithTypePredicateOverloads` in the rule source skips a locally-declared
  `x is T` callback on exactly those four methods, because wrapping it loses the narrowing. That is why
  `RoutingTelemetryPage.tsx`'s `data.groups.filter(isStrategyGroup)` is silent while
  `.some(isStrategyGroup)` six lines above it fires: `.some` has no predicate overload to lose, so the
  wrap there is free. An *imported* guard is exempted unconditionally — the rule is syntax-based and
  cannot see the predicate.
- 🔴 **Wrapping a `ReactNode`-returning callback trips `promise-function-async`.** React 19 types
  `ReactNode` as a union that includes `Promise<AwaitedReactNode>`, so `TruncatedList.tsx`'s
  `shown.map((item, index) => renderItem(item, index))` reads as a non-async promise-returning function.
  The explicit `: ReactNode` annotation the rule's own message suggests is the whole fix; expect it on
  every future wrap of a render callback.
- `renderItem` is also the one site whose second argument is load-bearing
  (`renderItem: (item: T, index: number) => ReactNode`), so that wrap passes `index` through — the others
  take the element alone.

**`no-await-in-loop` landed 2026-10-18** at the parent's `warn`, in the `Complexity controls` block over
`src/`, `worker/` and `scripts/`, with **no test exemption** — the parent does not exempt it either, so the
test trees inherit it from that block. Verified per tree with `eslint --print-config`: `1` for a `src/`,
`worker/`, `scripts/` and test file alike. All 32 hits matched the table's count exactly, 25 source / 7 test,
and every one was fixed by hand; the rule only ever offers suggestions.
- **Zero hits in `src/` production code and zero in `worker/`.** Every one was in `scripts/` or a test tree,
  which is why a rule the parent runs tree-wide cost this package nothing in the app itself.
- 🔴 **In four loops the sequencing *is* the safety property, not a style choice.** `kvBulkPut` returns on
  Cloudflare's daily-write-limit code, so concurrent chunks would already be in flight when the quota
  answer arrives; `scoreTurnWithReference`'s `canSpend()` gates each paid call on what the calls before it
  booked against `MAX_MEASURED_SPEND_USD`; `post-evaluations` and `upload-evaluations` both promise
  abort-on-first-failure (`upload`'s error path says "state saved up to the last accepted batch", which a
  concurrent send makes false); and `pickWorkingJudgeApiKey` probes keys in precedence order and returns the
  first accepted one. Parallelising any of them overshoots a cap or breaks a contract — read the loop's exit
  before calling a hit mechanical.
- **Three more are memory-bound, which the file alone does not show.** `sync-to-kv`'s per-org loop computes
  an org whole in memory (~1.65 GB on `prd`, the same figure that blocks the Workflow port),
  `backtest-degradation` holds one 100k-row result set at a time, and `judge-turns` streams JSONL precisely
  so a file is not resident. Those three directives carry the number, since nothing nearby does.
- **The rule reports a nested loop's iterable expression, not only awaits in the body.**
  `for (const turn of await extractTurns(info))` fires (`judge-agreement.ts`, `judge-quality-eval.ts`) —
  so does `for await (… of stream)` inside an outer loop. Do not go looking only for `await` statements.
- 🔴 **`eslint-disable-next-line` covers one line, so a two-await loop needs two directives.** That is what
  made the `await sleep(pollIntervalMs); batch = await this.poll(batch)` pair — spelled identically in
  `runBatch` and `cancelAndAwaitEnd` — worth extracting into `pollAfterInterval`: one helper took the batch
  provider's six flagged lines to two directives and removed the duplication. Reach for an extraction before
  a second directive on the same loop.
- **Four test loops were genuinely parallelisable, and became rewrites rather than disables.** Three
  `it('accepts all valid periods')` loops over a period/bucket list are now `it.each`, which also names the
  failing case (`api-trends`, `api-correlations`, `api-pipeline`); `WorkflowGraph`'s per-edge
  `await screen.findByTestId` became one `Promise.all` over `{ edge, element }` pairs.
- ⚠️ **Check the enclosing `beforeEach` before converting a loop to `it.each`.** `api-correlations`' loop
  called `fixture.reset()` per iteration, wiping the two evals its `describe`'s `beforeEach` seeds; the
  reset had to stay inside the `it.each` body or the cases would exercise seeded data instead of none.
  `api-pipeline`'s loop had no reset and its `beforeEach` reseeds, so there it was free.
- The two remaining test hits are disabled, both on loops whose rounds release each other:
  `runClock`'s fake-clock `while (!settled)` (appended to the directive it already carries for
  `no-unmodified-loop-condition` — the same callback-mutation blind spot recorded above) and
  `judge-evaluations.test.ts`'s `do…while` over answered judge rounds.
- `npm run lint` exits 0 under `--max-warnings 0` with the rule on.

**`unicorn/no-array-sort` landed 2026-10-18** at the parent's bare `error`, beside the other unicorn rules
in `typeSafetyRules`, so `src/`, `worker/` and `scripts/` and every test tree — the parent has no test
exemption for it either. All 65 hits matched the table exactly, 38 source / 27 test, and all were fixed by
hand: the rule offers suggestions, never an autofix.
- **It does not flag mutation; it flags a `.sort()` whose value is used.** `allowExpressionStatement`
  defaults to `true` and the parent's bare `error` takes that default, so a standalone `xs.sort(…)`
  statement stays legal — seven remain and are correctly silent (`workflow-graph.ts`,
  `code-quality-summary.ts`, `routes/quality.ts`, `account-stamps.ts`, `sync-to-kv.ts` and two in
  `worker/index.ts`). The one shape it always reports is `[...xs].sort()`, spread-and-mutate.
- 🔴 **`[...xs].sort()` → `xs.toSorted()` is valid only when `xs` is an Array**, which is why the rule
  offers two suggestions and leaves the choice to a human. 6 of the 23 spreads were unwrapped (`body.metrics`,
  `body.inputs`, `names`, `alerts`, `evals`, `loaded.spans`); the other 17 are over a Map, Set or iterator
  and keep the spread. **`tsc` is the gate** — unwrapping `[...HALLUCINATION_RISK_EVALUATION_NAMES]` failed
  with `Property 'toSorted' does not exist on type 'ReadonlySet<string>'`, so the wrong guess costs a round
  trip rather than a runtime `TypeError`. Unwrap on belief, then typecheck.
- 🔴 **The hazard the rule exists for was live once**: `computeEvalBreakdown` did
  `const sorted = d.scores.sort(ascending)` (`src/api/session-detail.ts`), reordering the d3 rollup's own
  stored array. Nothing reads `d.scores` after it today, so it was latent, not a defect — but the general
  form, a site that relies on the in-place sort *and* uses the return value, is a silent behaviour change
  under this rule and neither lint, `tsc` nor the tests would catch it. Check each named-variable or
  property receiver before converting; a `.map`/`.filter`/`Object.entries`/`Array.from`/`readdirSync`/
  `.slice()` receiver is inert by construction, and most of the 65 were.
- **A `.slice()` before the sort becomes redundant** — dropped at `routes/metrics.ts` and `routes/quality.ts`,
  since `toSorted()` already copies. `.toSorted()` with no comparator keeps `.sort()`'s string ordering.
- ⚠️ **`toSorted` is ES2023, so adopting this rule moves the floor.** Both tsconfigs already set
  `lib: ["ES2023"]`; Node and workerd have it, and no `worker/` production file had a hit. The browser
  bundle does gain it (`AlertList.tsx`, `FreqBarGrid.tsx`, `WorkflowGraph.tsx`, `lib/admin-customer.ts`),
  which needs Chrome 110 / Safari 16 / Firefox 115. This package pins no `browserslist` and no
  `build.target`, and Vite does not polyfill a prototype method in any case, so the floor is accepted
  rather than configured.

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

**The zero-hit rules landed 2026-10-19** at the parent's settings, with no sweep: `no-eval`, `no-new-func`,
`no-unreachable`, `no-unreachable-loop`, `unicorn/prefer-number-properties`, `@typescript-eslint/prefer-readonly`
and `no-useless-default-assignment`, and the `strict`-preset `no-useless-constructor`,
`no-non-null-asserted-nullish-coalescing` and `ban-ts-comment` (`minimumDescriptionLength: 10`), all in
`typeSafetyRules`; `vitest/no-disabled-tests`, `expect-expect` (the parent's `assertFunctionNames`) and
`valid-expect` (`maxArgs: 2`) in the `TEST_FILES` block; and `no-deprecated` warn → error. Verified per tree
with `eslint --print-config`, and `npm run lint` exits 0 under `--max-warnings 0`.
- `no-deprecated` stays on in the test trees, where the parent switches it off; it has no hits there.

**By category:**
- **Magic numbers.** `local/no-magic-numbers-ignore-bitwise` enabled at warn for non-test files
  2026-10-18: copied from the parent's inline definition into `eslint-rules/no-magic-numbers-ignore-bitwise.mjs`,
  with the parent's options. Swept from 155 hits to 0. `percent` and `TIME_MS` now have one definition each
  in `src/lib/constants.ts`, values an existing constant already named were swapped for it, shared values
  got one name, and coincidentally equal ones got distinct names. Still open:
  - **The 7 multiplier hits are resolved, but two wait on the parent.** The rule counts the multiplier in
    `3 * TIME_MS.HOUR`, and `enforceConst` does not exempt a binary-expression operand, so a named constant
    alone did not clear them. No existing constant held any of the 7 values, and the bare multipliers
    (12, 3, 16, 8) match only unrelated constants (`MONTHS_PER_YEAR`, `BITS.BYTE`, …), so none was swapped.
    - `MIN_SESSION_COMPLETION_AGE_MS` and `BATCH_WALL_CLOCK_MS` use new `DURATION_MS.TWELVE_HOURS` /
      `THREE_HOURS`, added to the parent's `src/lib/core/units.ts` on parent branch
      `feat/duration-ms-twelve-three-hours`, merged into the parent's local main as `ab2ecd00` (not yet
      pushed). 🔴 `scripts/` imports `units.ts` from the parent checkout by source path and `test:scripts`
      redirects that to the parent's `dist/`, so a checkout or build without the members fails
      `typecheck:scripts` (2 × TS2339) and lint (8 `no-unsafe-*`), and leaves both values `undefined` at
      run time — 4 `test:scripts` tests fail, and derive's completion-age guard and the batch wall clock
      are silently disabled. Rebuild the parent after pulling.
    - `DEFAULT_LOOKBACK_90D` is `PERIOD_MS['90d']`: `'90d'` is now a full period (`PERIOD_KEYS`,
      `VALID_PERIODS`, `PERIOD_MS`, the header selector, shortcut `4`, and `org-kv-entries`, which now
      iterates `PERIOD_KEYS` instead of its own copy of the list). ⚠️ **sync-to-kv still defaults to
      `--days=30`**, and `computeOrgKvEntries` skips any period longer than that, so no `:90d` KV entry is
      written until a run passes `--days=90`. The default was left alone deliberately: an org already
      holds ~1.65 GB in memory at 30 days, and the evaluation read spans `METRIC_DETAIL_WINDOWS` × the
      window. The parity tests' `it.each` period lists do not cover `90d`.
    - **So the header hides 90d until it has data.** `DATA_GATED_PERIOD` (`constants.ts`) names it;
      `Layout` asks `useOfferPeriod` — `useDashboard` for that period, which maps the worker's
      `ERR_NO_DATA` 404 to a `no_data` summary — and shows the button, and registers shortcut `4`, once a
      real summary comes back, when the check **fails** (so an outage never hides a period that has data),
      or while 90d is the selected period; it stays hidden only while the first check loads and on a
      no-data answer. `Layout.test.tsx` covers those five states against the real query stack. The gate
      re-checks every `DATA_GATE_POLL_INTERVAL_MS` (an hour, the KV refresh cadence) rather than the
      page's 30 s; react-query polls at the shortest interval among a key's observers, so it drops to
      30 s only while the 90d page itself is open. Lifting the gate means
      deleting `DATA_GATED_PERIOD` once a scheduled sync writes 90d; e2e asserts only the three
      always-offered periods, since the fourth depends on the environment's data.
    - The four byte and second multipliers (`BATCH_POLL_INTERVAL_MS`, `STDERR_CAPTURE_MAX_BYTES`,
      `KV_BATCH_MAX_BYTES`, `KV_VALUE_LIMIT_BYTES`) carry a one-line disable.
  - **Tests are not covered.** The parent's `local/no-magic-numbers-ignore-fixtures` variant was not copied.
  - **Score bands disagree with the thresholds.** `SCORE_BAND_LOWER_BOUNDS` (`[0.4, 0.6, 0.8, 0.9]`,
    `quality-utils.ts`) and `SCORE_THRESHOLD_GREEN`/`YELLOW` (0.8 / 0.5) band scores two ways and differ
    below 0.8; which one is right is a product decision.
  - **`scripts/populate-dashboard.ts` defines its own `MS_PER_SECOND = 1000`**, a copy of
    `TIME_MS.SECOND` the rule cannot see (a literal `const` initializer).
- **Complexity.** Done — ~~`max-depth` 4~~ and ~~`max-params` 4~~ landed 2026-10-17,
  ~~`no-await-in-loop`~~, ~~`complexity` 12~~ and ~~`sonarjs/no-duplicate-string`~~ 2026-10-18.
- **Imports.** Done — `import/no-cycle` and `import/no-extraneous-dependencies` both landed
  2026-10-17.
- **Formatting.** Done — ~~`@stylistic/indent` 2, `SwitchCase: 1`~~ (landed 2026-10-16).
- **Core.** Done — ~~`no-promise-executor-return`~~ (source only) and ~~`no-unmodified-loop-condition`~~
  landed 2026-10-17; ~~`no-eval`~~, ~~`no-new-func`~~, ~~`no-unreachable-loop`~~ and ~~`no-unreachable`~~
  (re-enabled over tseslint's `eslint-recommended`) 2026-10-19.
- **unicorn.** Done — ~~`no-array-sort`~~ and ~~`no-array-callback-reference`~~ landed 2026-10-18,
  ~~`prefer-number-properties`~~ 2026-10-19.
- **regexp.** Done — ~~`regexp/no-super-linear-move`~~ (landed 2026-10-17).
- **TypeScript.** ~~`dot-notation`~~, ~~`method-signature-style: property`~~,
  ~~`consistent-type-definitions: type`~~, ~~`no-unnecessary-type-arguments`~~ and
  ~~`promise-function-async`~~ landed 2026-10-16, ~~`unified-signatures`~~ 2026-10-17,
  ~~`strict-void-return`~~ (source only) 2026-10-18, and ~~`prefer-readonly`~~,
  ~~`no-useless-default-assignment`~~, ~~`no-useless-constructor`~~ and
  ~~`no-non-null-asserted-nullish-coalescing`~~ 2026-10-19. `explicit-function-return-type` is on for
  `src/api`, `src/hooks` and `src/lib` only (see above).
- **Option drift.** ~~`no-deprecated` warn → error~~ and ~~`ban-ts-comment` `minimumDescriptionLength: 10`~~
  landed 2026-10-19. Still open: `no-unused-vars` here also exempts `_`-prefixed destructured array elements.
  Keep `scripts/`' `prefer-nullish-coalescing` `ignorePrimitives: { boolean: true }`: it guards the
  `isDirectRun` checks.
- **Tests only.** Done — ~~`no-conditional-expect`~~ landed 2026-10-17, ~~`vitest/no-disabled-tests`~~,
  ~~`expect-expect`~~ and ~~`valid-expect` (`maxArgs: 2`)~~ 2026-10-19;
  `no-unnecessary-type-assertion` stays off here on purpose (see the comment in `eslint.config.mjs`).

New devDependencies: `@stylistic/eslint-plugin`, `eslint-plugin-import-x`,
`eslint-import-resolver-typescript` and `eslint-plugin-sonarjs` (all four installed, at the parent's
versions); the dashboard installs standalone in CI.

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

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
