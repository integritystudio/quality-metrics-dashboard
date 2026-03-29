import type { Plugin } from 'vite';
import path from 'path';

/** Matches 3+ level relative imports into a dist/ directory (e.g. ../../../dist/) */
export const PARENT_DIST_RE = /\.\.\/\.\.\/\.\.(?:\/\.\.)*\/dist\//;

/**
 * Stub parent dist/ imports accessed from scripts/__tests__/ (3+ levels up).
 * These are type-only imports; runtime stubs prevent import-analysis errors.
 */
export function parentDistStub(): Plugin {
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
