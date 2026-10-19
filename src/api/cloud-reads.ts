/**
 * One cloud read per distinct request, however many routes ask for it.
 *
 * A page load fans out to several routes that each read the same window, and
 * every one of them computed its own `now`, so the backend's own cache (keyed
 * on the raw nanosecond bounds) never matched. Keys here are the wire-level
 * request obtool-api receives — day-granular dates — so reads that would send
 * the same request share one: concurrent callers join the in-flight promise,
 * and with `CLOUD_READ_CACHE_TTL_MS` set, later callers reuse the result.
 *
 * Coalescing is always on. The TTL cache is opt-in for the e2e server, which
 * replays the same windows across specs and retries; the dev server stays
 * live by default.
 */
import { QueryCache } from './parent/cache.js';
import { toDateOnly } from './api-constants.js';

export const CLOUD_READ_CACHE_TTL_ENV = 'CLOUD_READ_CACHE_TTL_MS';

type ReadParam = string | number | boolean | undefined;

const inFlight = new Map<string, Promise<unknown>>();
let cache: QueryCache<object> | undefined;
let cacheTtlMs = 0;

function cacheFor(ttlMs: number): QueryCache<object> | undefined {
  if (ttlMs <= 0) return undefined;
  if (!cache || cacheTtlMs !== ttlMs) {
    cache = new QueryCache<object>(undefined, ttlMs);
    cacheTtlMs = ttlMs;
  }
  return cache;
}

function configuredTtlMs(): number {
  const ttl = Number(process.env[CLOUD_READ_CACHE_TTL_ENV]);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

/** The key of a read: its kind plus the request it sends, with window bounds at the day the wire carries. */
export function cloudReadKey(kind: string, params: Record<string, ReadParam>): string {
  const wire: Record<string, ReadParam> = {};
  for (const name of Object.keys(params).toSorted()) {
    const value = params[name];
    if (value === undefined) continue;
    wire[name] = name === 'start' || name === 'end' ? toDateOnly(String(value)) : value;
  }
  return `${kind}:${JSON.stringify(wire)}`;
}

/** Runs `read` unless an identical read is in flight or, with the TTL cache on, recently finished. */
export async function sharedCloudRead<T extends object>(key: string, read: () => Promise<T>): Promise<T> {
  const results = cacheFor(configuredTtlMs());
  const cached = results?.get(key);
  if (cached !== undefined) return cached as T;

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = read().then((result) => {
    results?.set(key, result);
    return result;
  }).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

/** Drops cached and in-flight reads; for tests that change the TTL or the served rows between cases. */
export function resetCloudReads(): void {
  inFlight.clear();
  cache?.clear();
  cache = undefined;
  cacheTtlMs = 0;
}
