/**
 * Tests for `OrgContext.switchOrg`'s effect on the query cache
 * (ORG-SWITCH-REFETCHES-OLD-ORG).
 *
 * Two real `useApiQuery` hooks are mounted under the real `OrgProvider` and
 * react-query stack; only `useAuth` and `fetch` are substituted. The stubbed
 * worker echoes the request's `X-Org-Id`, so each query's data names the org it
 * was fetched under. A switch used to call `invalidateQueries()`, which
 * refetched every mounted query under the OLD org before the key change fetched
 * it again under the new one.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { OrgProvider, useOrg } from '../contexts/OrgContext.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import type { AppSession, OrgMembershipSummary } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, headersOf } from './support/query-harness.js';

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const SWITCH_URL = `/api/org/switch`;
const HTTP_OK = 200;

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
};

const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: SESSION, getAccessToken }),
}));

interface OrgEcho {
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

afterEach(() => {
  vi.unstubAllGlobals();
  // switchOrg persists the choice, and OrgProvider reads it on mount.
  try {
    window.localStorage.clear();
  } catch {
    // Node 26's own global localStorage (undefined without --localstorage-file)
    // shadows jsdom's, so nothing was persisted — api-client tolerates it too.
  }
});

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

  it("drops the previous org's cached queries", async () => {
    const { queryClient } = await renderAndSwitch();

    const cachedOrgs = queryClient.getQueryCache().findAll().map((query) => query.queryKey[0]);
    expect(cachedOrgs).toEqual([ORG_B, ORG_B]);
    queryClient.clear();
  });
});
