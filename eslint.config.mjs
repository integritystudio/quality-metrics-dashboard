import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

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
            message: '@parent is confined to the boundary modules: src/api/parent/*, src/types.ts, src/lib/validation/dashboard-schemas.ts (scripts/ excepted).',
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
