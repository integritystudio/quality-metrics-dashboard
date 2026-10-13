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
| DASH-LINT-PARENT-PARITY | Parent ESLint rules the dashboard does not enforce | P3 | Each group likely needs a sweep first; hit counts not measured. Source: session 2026-10-12 |

**DASH-LINT-PARENT-PARITY.** Diffed with `eslint --print-config` on one src, worker, scripts and test file
here against `../src/server.ts` and a parent test under the parent's `eslint.config.cjs`. The cheap subset
(`prefer-template`, `object-shorthand`, `unicorn/throw-new-error`, `unicorn/prefer-node-protocol`, strict
`restrict-template-expressions`, `vitest/no-focused-tests`, `vitest/no-identical-title`) already landed.
Unless noted, each rule is missing from `src/`, `worker/` and `scripts/` alike.
- **Lint gate.** `--max-warnings 0` on `npm run lint` (241 warnings today); `linterOptions`
  `reportUnusedDisableDirectives: 'error'` (here `warn`) and `reportUnusedInlineConfigs: 'error'`.
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
exclusions, and `npm run lint` exits 0.

Completed items are migrated to [docs/changelog/](changelog/) — most recently
[v3.0.12](changelog/3.0.12/CHANGELOG.md) (2026-10-12).

Parent-repo backlog: [`../../docs/BACKLOG.md`](../../docs/BACKLOG.md).
