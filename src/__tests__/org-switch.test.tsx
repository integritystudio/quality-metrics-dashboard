/**
 * Org switching under the real `OrgProvider` and react-query stack. Only the
 * two external boundaries are substituted: `useAuth` (the Auth0 SDK) and
 * `fetch`, so the requests themselves are the assertion targets.
 *
 * - `OrgSwitcher`: the `POST /api/org/switch` request and its failure paths.
 * - `OrgContext.switchOrg`'s effect on the query cache
 *   (ORG-SWITCH-REFETCHES-OLD-ORG). The stubbed worker echoes the request's
 *   `X-Org-Id`, so each query's data names the org it was fetched under. A
 *   switch used to call `invalidateQueries()`, which refetched every mounted
 *   query under the OLD org before the key change fetched it again under the
 *   new one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { OrgSwitcher } from '../components/OrgSwitcher.js';
import { OrgProvider, useOrg } from '../contexts/OrgContext.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { getStoredOrgId } from '../lib/api-client.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import { APP_SESSION_QUERY_KEY } from '../lib/query-keys.js';
import type { AppSession, OrgMembershipSummary } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, headersOf, makeQueryWrapper, stubFetch } from './support/query-harness.js';
import { defined } from './support/defined.js';

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const SWITCH_URL = '/api/org/switch';
const FAILURE_TEXT = 'Failed to switch organization';
const NETWORK_ERROR_MESSAGE = 'Failed to fetch';
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;

function membership(orgId: string, name: string): OrgMembershipSummary {
  return { orgId, slug: name, name, membershipRole: 'member', dashboardRole: 'read' };
}

const SESSION: AppSession = {
  email: 'member@example.com',
  roles: [],
  permissions: ['dashboard.read'],
  allowedViews: ['executive'],
  activeOrgId: ORG_A,
  memberships: [membership(ORG_A, 'org-a'), membership(ORG_B, 'org-b')],
  isStaff: false,
};

const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: SESSION, isLoading: false, getAccessToken }),
}));

beforeEach(() => {
  // switchOrg persists the choice, and OrgProvider reads it on mount. Clear the
  // store api-client uses: Node 26's own global localStorage can shadow jsdom's.
  globalThis.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderSwitcher() {
  const { wrapper: QueryWrapper } = makeQueryWrapper();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryWrapper>
        <OrgProvider>{children}</OrgProvider>
      </QueryWrapper>
    );
  }
  render(<OrgSwitcher />, { wrapper: Wrapper });
  return screen.getByRole('combobox', { name: 'Switch organization' });
}

describe('OrgSwitcher', () => {
  it('posts the chosen org to /api/org/switch and makes it active', async () => {
    const fetchSpy = stubFetch({});
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_B } });

    await waitFor(() => expect(select).toHaveValue(ORG_B));
    expect(select).toBeEnabled();
    expect(screen.queryByText(FAILURE_TEXT)).not.toBeInTheDocument();
    expect(getStoredOrgId()).toBe(ORG_B);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = defined(fetchSpy.mock.calls[0]);
    expect(url).toBe(SWITCH_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ orgId: ORG_B });
    expect(headersOf(init)).toMatchObject({
      Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      [ORG_ID_HEADER]: ORG_B,
    });
  });

  it('reports a rejected switch and keeps the current org', async () => {
    stubFetch({ error: 'Forbidden' }, { status: HTTP_FORBIDDEN });
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_B } });

    expect(await screen.findByText(FAILURE_TEXT)).toBeInTheDocument();
    expect(select).toBeEnabled();
    expect(select).toHaveValue(ORG_A);
    expect(getStoredOrgId()).toBeNull();
  });

  it('reports a switch that never reaches the server', async () => {
    const fetchSpy = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new TypeError(NETWORK_ERROR_MESSAGE)));
    vi.stubGlobal('fetch', fetchSpy);
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_B } });

    expect(await screen.findByText(FAILURE_TEXT)).toBeInTheDocument();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(SWITCH_URL);
    expect(select).toHaveValue(ORG_A);
    expect(getStoredOrgId()).toBeNull();
  });

  it('ignores re-selecting the active org', () => {
    const fetchSpy = stubFetch({});
    const select = renderSwitcher();

    fireEvent.change(select, { target: { value: ORG_A } });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(select).toHaveValue(ORG_A);
  });
});

type OrgEcho = {
  org: string | undefined;
}

/** Stub the worker: the switch answers `{}`, every other route echoes `X-Org-Id`. */
function stubOrgEchoFetch() {
  const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
    const body = url === SWITCH_URL ? {} : { org: headersOf(init)[ORG_ID_HEADER] };
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: HTTP_OK,
      headers: { 'Content-Type': 'application/json' },
    }));
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function useTwoQueriesAndOrg() {
  const org = useOrg();
  const first = useApiQuery<OrgEcho>(['first'], () => `/api/first`);
  const second = useApiQuery<OrgEcho>(['second'], () => `/api/second`);
  return { org, first, second };
}

/**
 * Mount both queries under ORG_A, switch to ORG_B, and wait until both hold
 * ORG_B data. The QueryClient keeps react-query's default gcTime, so a query
 * the switch fails to drop is still in the cache afterwards.
 */
async function renderAndSwitch() {
  const fetchSpy = stubOrgEchoFetch();
  const queryClient = new QueryClient();
  queryClient.setQueryData(APP_SESSION_QUERY_KEY, SESSION);
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <OrgProvider>{children}</OrgProvider>
      </QueryClientProvider>
    );
  }
  const { result } = renderHook(useTwoQueriesAndOrg, { wrapper: Wrapper });
  await waitFor(() => {
    expect(result.current.first.data?.org).toBe(ORG_A);
    expect(result.current.second.data?.org).toBe(ORG_A);
  });
  fetchSpy.mockClear();

  let switched = false;
  await act(async () => { switched = await result.current.org.switchOrg(ORG_B); });
  await waitFor(() => {
    expect(result.current.first.data?.org).toBe(ORG_B);
    expect(result.current.second.data?.org).toBe(ORG_B);
  });
  return { fetchSpy, queryClient, switched };
}

describe('OrgContext.switchOrg', () => {
  it('fetches each mounted query once, under the new org only', async () => {
    const { fetchSpy, queryClient, switched } = await renderAndSwitch();

    expect(switched).toBe(true);
    const dataCallOrgs = fetchSpy.mock.calls
      .filter(([url]) => url !== SWITCH_URL)
      .map(([, init]) => headersOf(init)[ORG_ID_HEADER]);
    expect(dataCallOrgs).toEqual([ORG_B, ORG_B]);
    queryClient.clear();
  });

  it("drops the previous org's cached queries and keeps the session", async () => {
    const { queryClient } = await renderAndSwitch();

    const cachedKeys = queryClient.getQueryCache().findAll().map((query) => query.queryKey[0]);
    expect(cachedKeys).toEqual([APP_SESSION_QUERY_KEY[0], ORG_B, ORG_B]);
    queryClient.clear();
  });
});
