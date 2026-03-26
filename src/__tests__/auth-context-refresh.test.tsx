/**
 * AuthContext — TOKEN_REFRESHED event path
 *
 * Verifies that when the supabase auth listener fires TOKEN_REFRESHED,
 * AuthContext re-fetches /api/me with the new access token and updates
 * the session state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, within } from '@testing-library/react';
import { AuthProvider, useAuth } from '../contexts/AuthContext.js';
import type { ReactNode } from 'react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

type AuthStateListener = (session: MockSupabaseSession | null, event: string) => void;

interface MockSupabaseSession {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: { id: string; email: string };
}

let capturedListener: AuthStateListener | null = null;

const mockGetSession = vi.fn();
const mockRefreshSession = vi.fn();
const mockOnAuthStateChange = vi.fn((listener: AuthStateListener) => {
  capturedListener = listener;
  return () => { capturedListener = null; };
});
const mockStartAutoRefresh = vi.fn();
const mockStopAutoRefresh = vi.fn();

vi.mock('../lib/supabase.js', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  refreshSession: (...args: unknown[]) => mockRefreshSession(...args),
  onAuthStateChange: (...args: unknown[]) => mockOnAuthStateChange(...args as [AuthStateListener]),
  startAutoRefresh: (...args: unknown[]) => mockStartAutoRefresh(...args),
  stopAutoRefresh: (...args: unknown[]) => mockStopAutoRefresh(...args),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/activity-logger.js', () => ({
  postActivityEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(accessToken: string): MockSupabaseSession {
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'user-id-1', email: 'user@test.com' },
  };
}

function makeMeResponse(email: string) {
  return {
    email,
    roles: ['operator'],
    permissions: ['dashboard.read', 'dashboard.operator'],
    allowedViews: ['operator'],
  };
}

function TestConsumer() {
  const { session, isLoading } = useAuth();
  if (isLoading) return <div data-testid="loading">loading</div>;
  if (!session) return <div data-testid="no-session">no session</div>;
  return <div data-testid="session-email">{session.email}</div>;
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  capturedListener = null;
  mockGetSession.mockReturnValue(null);
  mockRefreshSession.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthContext: TOKEN_REFRESHED event', () => {
  it('re-fetches /api/me with the new token on TOKEN_REFRESHED', async () => {
    const initialToken = 'initial-access-token';
    const refreshedToken = 'refreshed-access-token';

    // Initial load: no session
    mockGetSession.mockReturnValue(null);
    mockRefreshSession.mockResolvedValue(null);

    const fetchSpy = vi.fn();

    fetchSpy.mockImplementation((url: string, init?: RequestInit) => {
      const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      if (url.includes('/api/me')) {
        if (authHeader.includes(initialToken)) {
          return Promise.resolve(new Response(JSON.stringify(makeMeResponse('initial@test.com')), { status: 200 }));
        }
        if (authHeader.includes(refreshedToken)) {
          return Promise.resolve(new Response(JSON.stringify(makeMeResponse('refreshed@test.com')), { status: 200 }));
        }
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    // Initially loading
    await waitFor(() => {
      expect(scope.getByTestId('no-session')).toBeDefined();
    });

    // Fire SIGNED_IN with initial token
    await act(async () => {
      capturedListener?.(makeSession(initialToken), 'SIGNED_IN');
    });

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('initial@test.com');
    });

    const callsBeforeRefresh = fetchSpy.mock.calls.length;

    // Fire TOKEN_REFRESHED with new token
    await act(async () => {
      capturedListener?.(makeSession(refreshedToken), 'TOKEN_REFRESHED');
    });

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('refreshed@test.com');
    });

    // Verify /api/me was called with the refreshed token
    const meCallsAfterRefresh = (fetchSpy.mock.calls as Array<[string, RequestInit | undefined]>)
      .slice(callsBeforeRefresh)
      .filter(([url]) => url.includes('/api/me'));

    expect(meCallsAfterRefresh.length).toBeGreaterThan(0);
    const refreshedMeCall = meCallsAfterRefresh.find(([, init]) => {
      const authHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return authHeader.includes(refreshedToken);
    });
    expect(refreshedMeCall).toBeDefined();
  });

  it('clears session on SIGNED_OUT after TOKEN_REFRESHED had set session', async () => {
    const token = 'some-access-token';

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/me')) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    // Sign in
    await act(async () => {
      capturedListener?.(makeSession(token), 'SIGNED_IN');
    });
    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    // Sign out
    await act(async () => {
      capturedListener?.(null, 'SIGNED_OUT');
    });
    await waitFor(() => {
      expect(scope.queryByTestId('session-email')).toBeNull();
      expect(scope.getByTestId('no-session')).toBeDefined();
    });
  });

  it('starts auto-refresh on mount and stops on unmount', async () => {
    mockGetSession.mockReturnValue(null);
    mockRefreshSession.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const { unmount } = render(<TestConsumer />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(mockStartAutoRefresh).toHaveBeenCalledTimes(1);
    });

    unmount();

    expect(mockStopAutoRefresh).toHaveBeenCalledTimes(1);
  });
});
