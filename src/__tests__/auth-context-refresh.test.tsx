/**
 * AuthContext — Auth0 integration
 *
 * Verifies that AuthContext fetches /api/me when Auth0 reports isAuthenticated,
 * clears session when not authenticated, and exposes getAccessToken.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, within } from '@testing-library/react';
import { AuthProvider, useAuth } from '../contexts/AuthContext.js';
import type { ReactNode } from 'react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetAccessTokenSilently = vi.fn();
const mockLogout = vi.fn();

let mockIsAuthenticated = false;
let mockIsLoading = false;

vi.mock('../lib/auth0.js', () => ({
  useAuth0: () => ({
    isLoading: mockIsLoading,
    isAuthenticated: mockIsAuthenticated,
    getAccessTokenSilently: mockGetAccessTokenSilently,
    logout: mockLogout,
  }),
  AUTH0_DOMAIN: 'placeholder.us.auth0.com',
  AUTH0_CLIENT_ID: 'placeholder-client-id',
  AUTH0_AUDIENCE: 'https://placeholder.api.dev',
  Auth0Provider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('../lib/activity-logger.js', () => ({
  postActivityEvent: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
  mockIsAuthenticated = false;
  mockIsLoading = false;
  mockGetAccessTokenSilently.mockResolvedValue('mock-access-token');
  mockLogout.mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AuthContext: authenticated state', () => {
  it('fetches /api/me with the access token when authenticated', async () => {
    mockIsAuthenticated = true;

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/me')) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    const meCalls = (fetchSpy.mock.calls as Array<[string, RequestInit | undefined]>)
      .filter(([url]) => url.includes('/api/me'));
    expect(meCalls.length).toBeGreaterThan(0);
    const authHeader = (meCalls[0][1]?.headers as Record<string, string>)?.['Authorization'];
    expect(authHeader).toBe('Bearer mock-access-token');
  });

  it('clears session when not authenticated', async () => {
    mockIsAuthenticated = false;
    vi.stubGlobal('fetch', vi.fn());

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('no-session')).toBeDefined();
    });
  });

  it('shows loading while auth0 is initializing', async () => {
    mockIsLoading = true;
    vi.stubGlobal('fetch', vi.fn());

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    // Should stay in loading state while auth0Loading is true
    expect(scope.getByTestId('loading')).toBeDefined();
  });

  it('clears session when /api/me returns an error', async () => {
    mockIsAuthenticated = true;

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/me')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('no-session')).toBeDefined();
    });
  });
});

describe('AuthContext: signOut', () => {
  it('calls Auth0 logout on signOut', async () => {
    mockIsAuthenticated = true;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/me')) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));

    function SignOutTrigger() {
      const { signOut, session } = useAuth();
      return (
        <div>
          <div data-testid="email">{session?.email ?? 'none'}</div>
          <button data-testid="sign-out" onClick={() => void signOut()}>Sign out</button>
        </div>
      );
    }

    const { container } = render(<SignOutTrigger />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('email').textContent).toBe('user@test.com');
    });

    await act(async () => {
      scope.getByTestId('sign-out').click();
    });

    expect(mockLogout).toHaveBeenCalledWith({ logoutParams: { returnTo: window.location.origin } });
  });
});
