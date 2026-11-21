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
 *
 * `React.lazy` caches a rejection for the life of the component, so an error
 * boundary's reset would rethrow it. A rejected load is swapped for a fresh one
 * only by `retryFailedLazyLoads()`, which the boundary calls from `onReset`;
 * swapping on rejection itself would let React's own render retry re-import in
 * a loop.
 */

import { createElement, lazy, type ComponentProps, type ComponentType, type LazyExoticComponent } from 'react';

/** sessionStorage key set while a stale-chunk reload is in flight; cleared by the next successful load. */
export const CHUNK_RELOAD_KEY = 'obs.chunkReloadPending';
const CHUNK_RELOAD_MARK = '1';

export type ChunkReloadEnv = {
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
export async function importWithReload<T>(load: () => Promise<T>, env: ChunkReloadEnv = browserEnv()): Promise<T> {
  return load().then(
    (module) => {
      clearReloadClaim(env.storage);
      return module;
    },
    async (error: unknown) => {
      if (!claimReload(env.storage)) throw error;
      env.reload();
      return new Promise<T>(() => {});
    },
  );
}

const failedLoadRenewers = new Set<() => void>();

/** Gives every lazy component whose import was rejected a fresh import for its next render. */
export function retryFailedLazyLoads(): void {
  for (const renew of failedLoadRenewers) renew();
  failedLoadRenewers.clear();
}

/** `React.lazy` with the same loader signature, generic over the component as React's is, plus an injectable env. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint; a narrower props type fails inference at every call site
export function lazyWithReload<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  env?: ChunkReloadEnv,
): ComponentType<ComponentProps<T>> {
  const createAttempt = (): LazyExoticComponent<T> => lazy(async () => importWithReload(load, env).catch((error: unknown) => {
    failedLoadRenewers.add(renew);
    throw error;
  }));
  const renew = (): void => {
    currentAttempt = createAttempt();
  };
  let currentAttempt = createAttempt();
  return function LazyWithReload(props: ComponentProps<T>) {
    return createElement(currentAttempt, props);
  };
}
