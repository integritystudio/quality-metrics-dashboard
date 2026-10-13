/**
 * AuthContext — Auth0 integration
 *
 * Verifies that AuthContext fetches /api/me when Auth0 reports isAuthenticated,
 * clears session when not authenticated, exposes getAccessToken, and posts
 * a login activity event exactly once per browser tab session.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, cleanup, within } from '@testing-library/react';
import { AuthProvider, SESSION_LOGIN_KEY, useAuth } from '../contexts/AuthContext.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = 'mock-access-token';
const ME_URL = '/api/me';
const ACTIVITY_URL = '/api/activity';
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_UNAUTHORIZED = 401;
const LOGIN_ACTIVITY = 'login';
const NETWORK_ERROR_MESSAGE = 'Failed to fetch';

type FetchCall = [string, RequestInit | undefined];

function callsTo(fetchSpy: ReturnType<typeof vi.fn>, url: string): FetchCall[] {
  return (fetchSpy.mock.calls as FetchCall[]).filter(([calledUrl]) => calledUrl === url);
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
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mockIsAuthenticated = false;
  mockIsLoading = false;
  mockGetAccessTokenSilently.mockResolvedValue(ACCESS_TOKEN);
  mockLogout.mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AuthContext: authenticated state', () => {
  it('fetches /api/me with the access token when authenticated', async () => {
    mockIsAuthenticated = true;

    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === ME_URL) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: HTTP_OK }));
      }
      return Promise.resolve(new Response(null, { status: HTTP_OK }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    const meCalls = (fetchSpy.mock.calls as Array<[string, RequestInit | undefined]>)
      .filter(([url]) => url === ME_URL);
    expect(meCalls.length).toBeGreaterThan(0);
    const authHeader = (meCalls[0]?.[1]?.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe(`Bearer ${ACCESS_TOKEN}`);
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

  it('shows loading while auth0 is initializing', () => {
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
      if (url === ME_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: HTTP_UNAUTHORIZED }));
      }
      return Promise.resolve(new Response(null, { status: HTTP_OK }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('no-session')).toBeDefined();
    });
  });
});

describe('AuthContext: login activity', () => {
  function makeAuthenticatedFetch(activityResponse: () => Promise<Response> = () =>
    Promise.resolve(new Response(null, { status: HTTP_CREATED }))) {
    return vi.fn().mockImplementation((url: string) => {
      if (url === ME_URL) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: HTTP_OK }));
      }
      if (url === ACTIVITY_URL) return activityResponse();
      return Promise.resolve(new Response(null, { status: HTTP_OK }));
    });
  }

  it('posts login activity when session is established for the first time', async () => {
    mockIsAuthenticated = true;
    const fetchSpy = makeAuthenticatedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    const activityCalls = callsTo(fetchSpy, ACTIVITY_URL);
    expect(activityCalls).toHaveLength(1);
    const [, init] = activityCalls[0]!;
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ activity_type: LOGIN_ACTIVITY });
    const headers = init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers).not.toHaveProperty(ORG_ID_HEADER);
    expect(sessionStorage.getItem(SESSION_LOGIN_KEY)).not.toBeNull();
  });

  it('keeps the session when the login activity post fails', async () => {
    mockIsAuthenticated = true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const networkError = new TypeError(NETWORK_ERROR_MESSAGE);
    const fetchSpy = makeAuthenticatedFetch(() => Promise.reject(networkError));
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    expect(callsTo(fetchSpy, ACTIVITY_URL)).toHaveLength(1);
    await act(() => Promise.allSettled(fetchSpy.mock.results.map((result) => result.value as Promise<Response>)));
    expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    await waitFor(() => expect(warnSpy).toHaveBeenCalledWith(expect.any(String), LOGIN_ACTIVITY, networkError));
  });

  it('does not post login activity on re-render when sessionStorage flag is already set', async () => {
    mockIsAuthenticated = true;
    sessionStorage.setItem(SESSION_LOGIN_KEY, '1');
    const fetchSpy = makeAuthenticatedFetch();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('session-email').textContent).toBe('user@test.com');
    });

    expect(callsTo(fetchSpy, ACTIVITY_URL)).toHaveLength(0);
  });

  it('does not post login activity when /api/me fails (no valid session)', async () => {
    mockIsAuthenticated = true;
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (url === ME_URL) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: HTTP_UNAUTHORIZED }));
      }
      return Promise.resolve(new Response(null, { status: HTTP_OK }));
    });
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<TestConsumer />, { wrapper: Wrapper });
    const scope = within(container);

    await waitFor(() => {
      expect(scope.getByTestId('no-session')).toBeDefined();
    });

    expect(callsTo(fetchSpy, ACTIVITY_URL)).toHaveLength(0);
    expect(sessionStorage.getItem(SESSION_LOGIN_KEY)).toBeNull();
  });
});

describe('AuthContext: signOut', () => {
  it('calls Auth0 logout on signOut', async () => {
    mockIsAuthenticated = true;

    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      if (url === ME_URL) {
        return Promise.resolve(new Response(JSON.stringify(makeMeResponse('user@test.com')), { status: HTTP_OK }));
      }
      return Promise.resolve(new Response(null, { status: HTTP_OK }));
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

    await act(() => {
      scope.getByTestId('sign-out').click();
      return Promise.resolve();
    });

    expect(mockLogout).toHaveBeenCalledWith({ logoutParams: { returnTo: window.location.origin } });
    // Regression: the local session must NOT be cleared while the /v2/logout
    // navigation is pending — clearing it re-renders RequireAuth → /login,
    // whose auto loginWithRedirect stomps the logout navigation and Auth0's
    // still-live session silently signs the user back in. The real page
    // unload is what discards local state on success.
    expect(scope.getByTestId('email').textContent).toBe('user@test.com');
  });
});
