/**
 * AccountBadge / useOwnUserRow — the first direct Supabase read in the SPA (CR62).
 *
 * The real react-query stack runs; only `useAuth0` and `fetch` are substituted. The badge
 * shows the email PostgREST returned for the ID token, sends the ID token (never the access
 * token), stays hidden in a build without Supabase, and does not retry a 401.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AccountBadge } from '../components/AccountBadge.js';
import { SUPABASE_API_KEY_HEADER } from '../lib/postgrest-client.js';

const URL = 'https://project.supabase.co';
const ANON_KEY = 'sb_publishable_test';
const ID_TOKEN = 'id-token-with-role';
const ACCESS_TOKEN = 'access-token-without-role';
const EMAIL = 'owner@example.com';
const ROW = { id: '00000000-0000-4000-8000-000000000001', email: EMAIL, name: null, email_verified: true, login_count: 3, last_login: '2026-10-06T01:00:00.000000+00:00' };

let mockIsAuthenticated = true;
const mockGetIdTokenClaims = vi.fn();

vi.mock('../lib/auth0.js', () => ({
  useAuth0: () => ({
    isAuthenticated: mockIsAuthenticated,
    getIdTokenClaims: mockGetIdTokenClaims,
    getAccessTokenSilently: () => Promise.resolve(ACCESS_TOKEN),
  }),
}));

function stubFetch(status: number, body: unknown) {
  const fetchSpy = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function Wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockIsAuthenticated = true;
  mockGetIdTokenClaims.mockResolvedValue({ __raw: ID_TOKEN });
  vi.stubEnv('VITE_SUPABASE_URL', URL);
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', ANON_KEY);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('AccountBadge', () => {
  it('shows the email PostgREST returned, requested with the ID token and the publishable key', async () => {
    const fetchSpy = stubFetch(200, [ROW]);

    render(<AccountBadge />, { wrapper: Wrapper });

    await waitFor(() => expect(screen.getByTestId('account-badge')).toHaveTextContent(EMAIL));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${URL}/rest/v1/users?select=id,email,name,email_verified,login_count,last_login&limit=1`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${ID_TOKEN}`);
    expect(headers[SUPABASE_API_KEY_HEADER]).toBe(ANON_KEY);
    expect(JSON.stringify(init)).not.toContain(ACCESS_TOKEN);
  });

  it('renders nothing and makes no request in a build without Supabase configured', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    const fetchSpy = stubFetch(200, [ROW]);

    render(<AccountBadge />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('account-badge')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders nothing and makes no request while signed out', async () => {
    mockIsAuthenticated = false;
    const fetchSpy = stubFetch(200, [ROW]);

    render(<AccountBadge />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('account-badge')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders nothing on a 401 and does not retry: an unlisted client never gains the role claim', async () => {
    const fetchSpy = stubFetch(401, { code: 'PGRST301', message: 'No suitable key or wrong key type' });

    render(<AccountBadge />, { wrapper: Wrapper });

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('account-badge')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when the read succeeds with no row', async () => {
    stubFetch(200, []);

    render(<AccountBadge />, { wrapper: Wrapper });

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('account-badge')).toBeNull();
  });
});
