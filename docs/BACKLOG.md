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
| DASH-LINT-PARENT-PARITY | Parent ESLint rules the dashboard does not enforce | P3 | Hit counts measured 2026-10-16; the 605 autofixable hits are swept and their 6 rules landed. 676 hits remain, none autofixable. Source: session 2026-10-12 |

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
| `@typescript-eslint/explicit-function-return-type` (warn) | 253 | 0 | 247 / 6 |
| ~~`@stylistic/indent`~~ (landed) | 215 | 215 | 215 / 0 |
| `local/no-magic-numbers-ignore-bitwise` (warn) | 160 | 0 | 158 / 2 |
| `unicorn/no-array-sort` | 65 | 0 | 38 / 27 |
| ~~`@typescript-eslint/dot-notation`~~ (landed) | 49 | 49 | 22 / 27 |
| ~~`@typescript-eslint/promise-function-async`~~ (landed) | 46 | 46 | 45 / 1 |
| `complexity` 12 (warn) | 39 | 0 | 36 / 3 |
| `no-await-in-loop` (warn) | 32 | 0 | 25 / 7 |
| ~~`@typescript-eslint/method-signature-style`~~ (landed) | 31 | 31 | 13 / 18 |
| `unicorn/no-array-callback-reference` | 25 | 0 | 16 / 9 |
| `no-duplicate-imports` | 25 | 0 | 7 / 18 |
| `import/no-extraneous-dependencies` | 25 | 0 | 25 / 0 |
| `sonarjs/no-duplicate-string` (warn) | 15 | 0 | 15 / 0 |
| `max-params` 4 (warn) | 11 | 0 | 8 / 3 |
| `vitest/no-conditional-expect` | 9 | 0 | 0 / 9 |
| `@typescript-eslint/strict-void-return` | 5 | 0 | 2 / 3 |
| `regexp/no-super-linear-move` | 4 | 0 | 1 / 3 |
| `no-promise-executor-return` | 3 | 0 | 1 / 2 |
| ~~`@typescript-eslint/no-unnecessary-type-arguments`~~ (landed) | 3 | 3 | 3 / 0 |
| `max-depth` 4 (warn) | 2 | 0 | 2 / 0 |
| `no-unmodified-loop-condition` | 1 | 0 | 0 / 1 |
| `@typescript-eslint/unified-signatures` | 1 | 0 | 1 / 0 |

**Swept and landed 2026-10-16** (the six struck rows above, 605 hits, `npm run lint --fix`). Two of the
autofixes were not behaviour-preserving and were corrected by hand — note both before re-running a sweep:
- `consistent-type-definitions` rewrites `interface X extends Base` to `{...} & Base`, which **intersects**
  a member the interface form **overrode**. Recharts types `BarShapeProps['payload']` as `any`, so
  `DailyUsageChart.tsx`'s narrowed `payload` silently widened back to `any` (caught by `no-unsafe-*`).
  Fixed with `Omit<BarShapeProps, 'payload'> & { payload?: TonedDailyUsage }`.
- `no-unnecessary-type-arguments` stripped `<Edge>` from `useEdgesState<Edge>([])` in `WorkflowGraph.tsx`.
  The argument matches the default but is load-bearing: without it the empty literal infers `never[]` and
  every `setEdges` call fails to typecheck. Restored behind a one-line disable.

`@stylistic/eslint-plugin` was added as a devDependency for `@stylistic/indent`.
`promise-function-async` is off in test files, matching the parent's block and its reasoning (async stubs
for Promise-returning interfaces); with it on there it fires 154 extra times.

**Free today — zero hits, adoptable with no sweep:** `import/no-cycle` (the TypeScript resolver was
verified alive: the only unresolved specifier in the tree is the `web-worker` Vite alias, so the graph is
real and the pass is not silent), `no-eval`, `no-new-func`, `no-unreachable`, `no-unreachable-loop`,
`unicorn/prefer-number-properties`, `@typescript-eslint/prefer-readonly`, `no-useless-constructor`,
`no-useless-default-assignment`, `no-non-null-asserted-nullish-coalescing`, `vitest/no-disabled-tests`,
`vitest/expect-expect`, `vitest/valid-expect`, and both option-drift changes
(`no-deprecated` warn → error, `ban-ts-comment` `minimumDescriptionLength: 10`).
- **Magic numbers.** `local/no-magic-numbers-ignore-bitwise` (warn) and, in tests,
  `local/no-magic-numbers-ignore-fixtures`. The rule is defined inline in the parent's CJS config and not
  exported, so it must be extracted into a shared module or copied.
- **Complexity.** `complexity` 12, `max-depth` 4, `max-params` 4, `no-await-in-loop`, `sonarjs/no-duplicate-string`
  (all warn).
- **Imports.** `import/no-cycle` and `import/no-extraneous-dependencies` (via `eslint-plugin-import-x` and
  `eslint-import-resolver-typescript`), `no-duplicate-imports`.
- **Formatting.** `@stylistic/indent` 2, `SwitchCase: 1`.
- **Core.** `no-eval`, `no-new-func`, `no-promise-executor-return` (source only), `no-unreachable-loop`,
  `no-unmodified-loop-condition`, `no-unreachable` (off here via tseslint's `eslint-recommended`).
- **unicorn.** `no-array-sort`, `no-array-callback-reference`, `prefer-number-properties` (partly covered here by
  `no-restricted-globals` and `radix`).
- **regexp.** `regexp/no-super-linear-move`.
- **TypeScript.** `dot-notation`, `explicit-function-return-type` (warn), `method-signature-style: property`,
  `consistent-type-definitions: type`, `prefer-readonly`, `no-unnecessary-type-arguments`,
  `no-useless-default-assignment`, `promise-function-async` and `strict-void-return` (source only); from the
  `strict` preset `unified-signatures`, `no-useless-constructor`, `no-non-null-asserted-nullish-coalescing`.
- **Option drift.** `no-deprecated` is `error` there, `warn` here; `ban-ts-comment` wants
  `minimumDescriptionLength: 10`; `no-unused-vars` here also exempts `_`-prefixed destructured array elements.
  Keep `scripts/`' `prefer-nullish-coalescing` `ignorePrimitives: { boolean: true }`: it guards the
  `isDirectRun` checks.
- **Tests only.** `vitest/no-disabled-tests`, `expect-expect`, `no-conditional-expect`, `valid-expect` (`maxArgs: 2`);
  `no-unnecessary-type-assertion` stays off here on purpose (see the comment in `eslint.config.mjs`).

New devDependencies: `@stylistic/eslint-plugin`, `eslint-plugin-import-x`, `eslint-import-resolver-typescript`,
`eslint-plugin-sonarjs`, at the parent's versions; the dashboard installs standalone in CI.

Acceptance: re-running the `--print-config` diff lists no parent rule absent here except the documented
exclusions, and `npm run lint` exits 0 under `--max-warnings 0`.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
