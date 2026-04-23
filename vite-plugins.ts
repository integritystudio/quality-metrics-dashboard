import type { Plugin } from 'vite';
import path from 'path';
import { existsSync } from 'fs';

/** Matches 3+ level relative imports into a dist/ directory (e.g. ../../../dist/) */
export const PARENT_DIST_RE = /\.\.\/\.\.\/\.\.(?:\/\.\.)*\/dist\//;
/** Matches imports through the @parent/ alias (resolves to ../dist/ at runtime) */
export const PARENT_ALIAS_RE = /^@parent\//;

/**
 * Stub parent dist/ imports accessed from scripts/__tests__/ (3+ levels up)
 * and @parent/-aliased imports. These are type-only imports at test time;
 * runtime stubs prevent import-analysis errors when the parent dist is absent
 * (e.g. in standalone dashboard CI).
 */
export function parentDistStub(): Plugin {
  // Only stub @parent/ alias imports when the parent dist/ is absent (e.g. in
  // standalone dashboard CI). When the parent is built locally, let the real
  // exports resolve so tests exercise actual schema behavior.
  const parentDistExists = existsSync(path.resolve(import.meta.dirname ?? __dirname, '../dist'));
  return {
    name: 'parent-dist-stub',
    enforce: 'pre',
    resolveId(source) {
      if (PARENT_DIST_RE.test(source)) {
        return '\0' + source.replace(/^(?:\.\.\/)+/, '');
      }
      if (!parentDistExists && PARENT_ALIAS_RE.test(source)) {
        return '\0' + source.replace(PARENT_ALIAS_RE, 'dist/');
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
export function parentSrcToDistRedirect(parentSrc: string, parentDist: string): Plugin {
  return {
    name: 'parent-src-to-dist-redirect',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return;
      const resolved = path.resolve(path.dirname(importer), source);
      if (resolved.startsWith(parentSrc + path.sep) || resolved === parentSrc) {
        return resolved.replace(parentSrc, parentDist);
      }
    },
  };
}
