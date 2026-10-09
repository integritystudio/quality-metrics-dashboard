import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import regexp from 'eslint-plugin-regexp';
import tanstackQuery from '@tanstack/eslint-plugin-query';
import eslintReact from '@eslint-react/eslint-plugin';

const noUnusedVarsRule = ['error', {
  argsIgnorePattern: '^_',
  varsIgnorePattern: '^_',
  destructuredArrayIgnorePattern: '^_',
  caughtErrorsIgnorePattern: '^_',
}];

// Type-safety rules enforced at error level for both src/worker and scripts/.
const typeSafetyRules = {
  '@typescript-eslint/no-unused-vars': noUnusedVarsRule,
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/restrict-template-expressions': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/prefer-nullish-coalescing': 'error',
  '@typescript-eslint/prefer-optional-chain': 'error',
  '@typescript-eslint/no-unnecessary-condition': 'error',
  '@typescript-eslint/prefer-promise-reject-errors': 'error',
  '@typescript-eslint/no-invalid-void-type': 'error',
  '@typescript-eslint/no-shadow': 'error',
  '@typescript-eslint/no-dynamic-delete': 'error',
  '@typescript-eslint/no-deprecated': 'warn',
  '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
  'eqeqeq': ['error', 'always', { null: 'ignore' }],
  'radix': 'error',
  'no-param-reassign': ['error', { props: false }],
  'array-callback-return': ['error', { checkForEach: true }],
  'guard-for-in': 'error',
  'no-self-compare': 'error',
  'no-constructor-return': 'error',
  'default-case-last': 'error',
  'no-restricted-globals': ['error',
    { name: 'isNaN', message: 'Global isNaN coerces its argument; use Number.isNaN.' },
    { name: 'isFinite', message: 'Global isFinite coerces its argument; use Number.isFinite.' },
    { name: 'event', message: 'Use the handler parameter, not window.event.' },
  ],
  'no-restricted-syntax': ['error',
    {
      selector: "CallExpression[callee.property.name='toFixed'][arguments.0.value=type(number)]",
      message: 'Pass a named precision constant to toFixed, not a numeric literal.',
    },
    {
      selector: "JSXAttribute[name.name='style'] ObjectExpression > Property:matches([key.type='Identifier'], [key.type='Literal'][key.value!=/^--/])",
      message: 'No inline styles: use a CSS class. Only CSS custom properties (--name) may be set through style.',
    },
    {
      selector: "CallExpression[callee.object.name='Math'][callee.property.name=/^(min|max)$/] > SpreadElement.arguments",
      message: 'Math.min/Math.max with a spread argument overflows the stack on large arrays; use d3-array min/max/extent.',
    },
  ],
};

// Relative reach-ins to the parent build output, any plausible depth.
// Package deep-imports (e.g. @xyflow/react/dist/style.css) stay legal.
const parentDistGlobs = ['./dist/**', '../dist/**', '../../dist/**', '../../../dist/**', '../../../../dist/**', '../../../../../dist/**'];

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  // src/ and worker/ files - uses tsconfig.json
  {
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts'],
    plugins: { 'react-hooks': reactHooks, 'react': react },
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...typeSafetyRules,
      '@typescript-eslint/restrict-plus-operands': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'react/jsx-no-comment-textnodes': 'error',
      'react/no-array-index-key': 'error',
      'react/no-children-prop': 'error',
      'react/no-danger-with-children': 'error',
      'react/no-unescaped-entities': 'error',
      'react/jsx-key': ['error', { checkFragmentShorthand: true, checkKeyMustBeforeSpread: true, warnOnDuplicates: true }],
      'react/no-unstable-nested-components': ['error', { allowAsProps: false }],
      'react/jsx-no-constructed-context-values': 'error',
      'react/no-object-type-as-default-prop': 'error',
    },
  },
  // Regex safety (polynomial backtracking, unused captures, confusable ranges) everywhere.
  {
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.ts'],
    plugins: regexp.configs['flat/recommended'].plugins,
    rules: regexp.configs['flat/recommended'].rules,
  },
  // TanStack Query hook hygiene (the preset is a one-element array).
  ...tanstackQuery.configs['flat/recommended'].map(config => ({ ...config, files: ['src/**/*.{ts,tsx}'] })),
  // Type-aware React rules. Rules that eslint-plugin-react or react-hooks already
  // enforce above are switched off here so each finding is reported once.
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: eslintReact.configs['recommended-type-checked'].plugins,
    settings: eslintReact.configs['recommended-type-checked'].settings,
    rules: {
      ...eslintReact.configs['recommended-type-checked'].rules,
      '@eslint-react/rules-of-hooks': 'off',
      '@eslint-react/exhaustive-deps': 'off',
      '@eslint-react/no-missing-key': 'off',
      '@eslint-react/no-array-index-key': 'off',
      '@eslint-react/no-nested-component-definitions': 'off',
      '@eslint-react/jsx-no-children-prop': 'off',
      '@eslint-react/jsx-no-comment-textnodes': 'off',
      '@eslint-react/dom-no-dangerously-set-innerhtml-with-children': 'off',
    },
  },
  // Accessibility of rendered markup; test mocks are not shipped.
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/__tests__/**', 'src/**/*.test.tsx'],
    plugins: jsxA11y.flatConfigs.recommended.plugins,
    rules: jsxA11y.flatConfigs.recommended.rules,
  },
  // src/ only: the browser and API server log through warn/error; scripts and the worker log by design.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // src/ and worker/ test files - relax type safety and async patterns
  {
    files: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/require-await': 'warn',
      '@typescript-eslint/no-misused-promises': 'warn',
      // Untyped Hono `app.request()` responses make `res.json()` untyped; the
      // explicit `as Record<string, any>` casts are required by `tsc` (without
      // them `body` is `unknown`). The rule misreports them as unnecessary and
      // `--fix` strips them, breaking typecheck. Disable it for tests only.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
  // scripts/ files - uses tsconfig.scripts.json
  {
    files: ['scripts/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.scripts.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...typeSafetyRules,
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-base-to-string': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': ['error', {
        // `foo?.endsWith(x) || foo?.endsWith(y)` is boolean | undefined — a
        // `??` fix would stop at a valid `false` instead of checking the
        // second operand, changing behavior. See isDirectRun guards in
        // scripts/{backtest-degradation,derive-evaluations,judge-evaluations,sync-to-kv}.ts.
        ignorePrimitives: { boolean: true },
      }],
    },
  },
  // Parent-boundary enforcement (DASH-DIST-IMPORT). The parent
  // observability-toolkit's build output must never be imported by relative
  // dist/ path, and @parent (the sanctioned alias) is confined to the
  // boundary modules so every parent dependency is visible in one place.
  {
    files: ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: parentDistGlobs,
            message: 'Do not import the parent build output by relative path. Use src/api/parent/* (runtime code) or src/types.ts (types); scripts may use @parent directly.',
          },
          {
            group: ['@parent/*'],
            message: '@parent is confined to the boundary modules: src/api/parent/*, src/types.ts, src/lib/validation/dashboard-schemas.ts, src/lib/otel-attributes.ts (scripts/ excepted).',
          },
        ],
      }],
    },
  },
  // Boundary modules and scripts/: @parent allowed, relative dist/ still banned.
  {
    files: [
      'src/api/parent/**/*.ts',
      'src/types.ts',
      'src/lib/validation/dashboard-schemas.ts',
      'src/lib/otel-attributes.ts',
      'scripts/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            group: parentDistGlobs,
            message: 'Do not import the parent build output by relative path — use the @parent alias.',
          },
        ],
      }],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'playwright-report/', 'test-results/', 'scripts/*.js'],
  },
);
