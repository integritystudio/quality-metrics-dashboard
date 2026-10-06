// @vitest-environment node
/**
 * The stored-org helpers must work in a runtime with storage but no `window`
 * (SCRIPTS-TYPECHECK-WINDOW).
 *
 * `tsconfig.scripts.json` type-checks `src/lib` without the DOM lib, so the
 * helpers reach storage through `globalThis`. Reading it through `window`
 * again throws a ReferenceError here, which the helpers' `catch` swallows: the
 * choice is silently dropped instead of failing loudly. The node environment
 * reproduces that runtime; jsdom would hide it behind its own `window`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getStoredOrgId, setStoredOrgId } from '../lib/api-client.js';

const ORG_ID = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';
const NOT_AN_ORG_ID = 'not-a-uuid';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function memoryStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function unavailableStorage(): StorageLike {
  const refuse = (): never => {
    throw new DOMException('storage disabled', 'SecurityError');
  };
  return { getItem: refuse, setItem: refuse };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('stored org id without a window global', () => {
  it('reads back the org id it stored', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(typeof window).toBe('undefined');

    setStoredOrgId(ORG_ID);

    expect(getStoredOrgId()).toBe(ORG_ID);
  });

  it('returns null for a stored value that is not a uuid', () => {
    vi.stubGlobal('localStorage', memoryStorage());

    setStoredOrgId(NOT_AN_ORG_ID);

    expect(getStoredOrgId()).toBeNull();
  });

  it('returns null and does not throw when storage refuses access', () => {
    vi.stubGlobal('localStorage', unavailableStorage());

    expect(() => setStoredOrgId(ORG_ID)).not.toThrow();
    expect(getStoredOrgId()).toBeNull();
  });
});
