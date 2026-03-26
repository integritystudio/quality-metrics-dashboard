/**
 * supabase.ts — refreshSession() concurrent call coalescing
 *
 * Verifies that concurrent calls to refreshSession() are coalesced onto a
 * single in-flight promise so only one network request is made. Without this
 * guard, simultaneous auto-refresh timer ticks (e.g. multiple tabs) would each
 * send a refresh request; Supabase rotates the token on first use, so the
 * second call uses a stale token and triggers an unexpected sign-out.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module-level state reset ─────────────────────────────────────────────────
// supabase.ts uses module-level singletons (cachedSession, refreshInFlight).
// Re-import the module fresh per test via vi.resetModules().

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('localStorage', {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
  vi.stubEnv('VITE_SUPABASE_URL', 'https://test.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'test-anon-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStoredSession(refreshToken: string) {
  return JSON.stringify({
    access_token: 'access-token',
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-id', email: 'user@test.com' },
  });
}

function makeTokenResponse(accessToken: string, refreshToken: string) {
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    user: { id: 'user-id', email: 'user@test.com' },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('refreshSession(): concurrent call coalescing', () => {
  it('makes only one network request when called concurrently', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(makeStoredSession('refresh-token-1')),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    let resolveRefresh!: (value: Response) => void;
    const refreshLatch = new Promise<Response>((resolve) => { resolveRefresh = resolve; });

    const fetchSpy = vi.fn().mockReturnValue(refreshLatch);
    vi.stubGlobal('fetch', fetchSpy);

    const { refreshSession } = await import('../lib/supabase.js');

    // Fire two concurrent calls before the first resolves
    const call1 = refreshSession();
    const call2 = refreshSession();

    // Resolve the single pending fetch
    resolveRefresh(new Response(JSON.stringify(makeTokenResponse('new-access', 'new-refresh')), { status: 200 }));

    const [result1, result2] = await Promise.all([call1, call2]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result1?.access_token).toBe('new-access');
    expect(result2?.access_token).toBe('new-access');
  });

  it('clears the in-flight promise after completion so a subsequent call makes a fresh request', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue(makeStoredSession('refresh-token-1')),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });

    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(makeTokenResponse('new-access', 'new-refresh')), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const { refreshSession } = await import('../lib/supabase.js');

    await refreshSession();
    await refreshSession();

    // Each sequential call should hit the network
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns null without fetching when no session is stored', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { refreshSession } = await import('../lib/supabase.js');

    const result = await refreshSession();

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
