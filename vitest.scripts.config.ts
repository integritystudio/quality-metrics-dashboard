import { defineConfig } from 'vitest/config';
import path from 'path';
import type { Plugin } from 'vite';

const PARENT_SRC = path.resolve(__dirname, '../src');
const PARENT_DIST = path.resolve(__dirname, '../dist');

const PARENT_DIST_RE = /\.\.\/\.\.\/\.\.(?:\/\.\.)*\/dist\//;

/**
 * Stub parent dist/ imports accessed from scripts/__tests__/ (3+ levels up).
 * These are type-only imports; runtime stubs prevent import-analysis errors.
 */
function parentDistStub(): Plugin {
  return {
    name: 'parent-dist-stub',
    enforce: 'pre',
    resolveId(source) {
      if (PARENT_DIST_RE.test(source)) {
        return '\0' + source.replace(/^(?:\.\.\/)+/, '');
      }
    },
    load(id) {
      if (id.startsWith('\0dist/')) {
        return 'export {};';
      }
    },
  };
}

/**
 * Redirect ../../src/ imports from files inside scripts/ to ../../dist/.
 * Scripts reference the parent package using src/-relative paths, but several
 * source files (local-jsonl, quality-feature-engineering, etc.) only exist in
 * dist/ — the parent must be built before running this suite.
 */
function parentSrcToDistRedirect(): Plugin {
  return {
    name: 'parent-src-to-dist-redirect',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return;
      const resolved = path.resolve(path.dirname(importer), source);
      if (resolved.startsWith(PARENT_SRC + path.sep) || resolved === PARENT_SRC) {
        return resolved.replace(PARENT_SRC, PARENT_DIST);
      }
    },
  };
}

export default defineConfig({
  plugins: [parentDistStub(), parentSrcToDistRedirect()],
  resolve: {
    alias: {
      '@parent': PARENT_DIST,
    },
  },
  test: {
    environment: 'node',
    setupFiles: [],
    include: ['scripts/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', '.claude/**'],
  },
});
