import type { Plugin } from 'vite';
import path from 'path';
import { existsSync } from 'fs';

const STUB_ID_PREFIX = '\0dist/';

/** Matches imports through the @parent/ alias (resolves to ../dist/ at runtime) */
export const PARENT_ALIAS_RE = /^@parent\//;

/**
 * Stub @parent/-aliased imports when the parent dist/ is absent (e.g. in
 * standalone dashboard CI). @parent is the only sanctioned path to parent
 * code (relative dist/ imports are banned by eslint no-restricted-imports),
 * so this is the single stub point.
 *
 * Existence is checked per resolution rather than once at plugin init.
 * The match guard runs first so the stat is only paid for @parent imports,
 * not every module Vite resolves. Note: if dist/ is partially rebuilt while
 * tests run, some resolutions may return real exports and others the stub;
 * `npx vitest --clearCache` is the reset for that case.
 */
export function parentDistStub(): Plugin {
  const parentDistAbs = path.resolve(import.meta.dirname, '../dist');
  return {
    name: 'parent-dist-stub',
    enforce: 'pre',
    resolveId(source) {
      // Matches the bare alias (if this plugin sees it first) or the resolved
      // absolute path (if Vite's alias plugin ran first).
      const isAlias = PARENT_ALIAS_RE.test(source);
      if (!isAlias && !source.startsWith(parentDistAbs)) return;
      // A locally built parent resolves for real so tests exercise actual schemas.
      if (existsSync(parentDistAbs)) return;
      const relativePath = isAlias
        ? source.replace(PARENT_ALIAS_RE, '')
        : path.relative(parentDistAbs, source);
      return STUB_ID_PREFIX + relativePath;
    },
    load(id) {
      if (id.startsWith(STUB_ID_PREFIX)) {
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
