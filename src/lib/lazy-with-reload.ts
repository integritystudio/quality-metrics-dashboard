/**
 * `React.lazy` that survives a deploy (LAZY-CHUNK-STALE-AFTER-DEPLOY).
 *
 * Chunk names carry content hashes and every deploy replaces the asset
 * manifest, so a tab loaded before a deploy asks for chunks that no longer
 * exist; the Worker answers with `index.html` and the import rejects. The first
 * rejection reloads the page, which fetches the new manifest. A rejection after
 * that reload is a real failure and reaches the route's error boundary.
 *
 * This wraps the loader rather than listening for `vite:preloadError`: that
 * event comes from Vite's build-time preload helper only, while a rejected
 * `import()` is caught here in dev, in tests and in production alike.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/** sessionStorage key set while a stale-chunk reload is in flight; cleared by the next successful load. */
export const CHUNK_RELOAD_KEY = 'obs.chunkReloadPending';
const CHUNK_RELOAD_MARK = '1';

export interface ChunkReloadEnv {
  /** Survives the reload; undefined when the browser refuses storage. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
  reload: () => void;
}

function browserEnv(): ChunkReloadEnv {
  let storage: ChunkReloadEnv['storage'];
  try {
    storage = globalThis.sessionStorage;
  } catch {
    // Storage blocked: without a guard a reload could loop, so none is attempted.
  }
  return { storage, reload: () => globalThis.location.reload() };
}

/** Whether this failure should reload: only once, and only when the guard can be stored. */
function claimReload(storage: ChunkReloadEnv['storage']): boolean {
  if (!storage) return false;
  try {
    if (storage.getItem(CHUNK_RELOAD_KEY) !== null) return false;
    storage.setItem(CHUNK_RELOAD_KEY, CHUNK_RELOAD_MARK);
    return true;
  } catch {
    return false;
  }
}

function clearReloadClaim(storage: ChunkReloadEnv['storage']): void {
  try {
    storage?.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    // Nothing to clear when storage is refused.
  }
}

/**
 * Runs a dynamic import. On the first rejection it reloads the page and never
 * settles, so Suspense keeps its fallback until the reload lands; on a
 * rejection after that reload it rethrows.
 */
export function importWithReload<T>(load: () => Promise<T>, env: ChunkReloadEnv = browserEnv()): Promise<T> {
  return load().then(
    (module) => {
      clearReloadClaim(env.storage);
      return module;
    },
    (error: unknown) => {
      if (!claimReload(env.storage)) throw error;
      env.reload();
      return new Promise<T>(() => {});
    },
  );
}

/** `React.lazy` with the same signature, generic over the component as React's is, plus an injectable env. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint; a narrower props type fails inference at every call site
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  env?: ChunkReloadEnv,
): LazyExoticComponent<T> {
  return lazy(() => importWithReload(load, env));
}
