import type { Plugin } from 'vite';
import path from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

/** Matches imports through the @parent/ alias (resolves to ../dist/ at runtime) */
export const PARENT_ALIAS_RE = /^@parent\//;

/**
 * Stub @parent/-aliased imports when the parent dist/ is absent (e.g. in
 * standalone dashboard CI). @parent is the only sanctioned path to parent
 * code (relative dist/ imports are banned by eslint no-restricted-imports),
 * so this is the single stub point.
 */
export function parentDistStub(): Plugin {
  // When the parent is built locally, let the real exports resolve so tests
  // exercise actual schema behavior.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const parentDistAbs = path.resolve(here, '../dist');
  const parentDistExists = existsSync(parentDistAbs);
  return {
    name: 'parent-dist-stub',
    enforce: 'pre',
    resolveId(source) {
      if (!parentDistExists) {
        // Match either the bare alias (if our plugin sees it first) or the
        // already-resolved absolute path (Vite's alias plugin may have run first).
        if (PARENT_ALIAS_RE.test(source)) {
          return '\0' + source.replace(PARENT_ALIAS_RE, 'dist/');
        }
        if (source.startsWith(parentDistAbs)) {
          return '\0dist/' + path.relative(parentDistAbs, source);
        }
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
