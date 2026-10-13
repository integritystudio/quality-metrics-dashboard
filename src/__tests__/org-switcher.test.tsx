/**
 * OrgSwitcher under the real `OrgProvider` and the real query stack. Only the
 * two external boundaries are substituted: `useAuth` (the Auth0 SDK) and
 * `fetch`, so the `POST /api/org/switch` request itself is the assertion target.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import { OrgSwitcher } from '../components/OrgSwitcher.js';
import { OrgProvider } from '../contexts/OrgContext.js';
import { getStoredOrgId } from '../lib/api-client.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import type { AppSession, OrgMembershipSummary } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, headersOf, makeQueryWrapper, stubFetch } from './support/query-harness.js';

const ORG_A = 'a0000000-0000-4000-8000-00000000000a';
const ORG_B = 'b0000000-0000-4000-8000-00000000000b';
const FAILURE_TEXT = 'Failed to switch organization';
const SWITCH_URL = '/api/org/switch';
const HTTP_FORBIDDEN = 403;
const NETWORK_ERROR_MESSAGE = 'Failed to fetch';

function membership(orgId: string, name: string): OrgMembershipSummary {
  return { orgId, slug: name, name, membershipRole: 'member', dashboardRole: 'read' };
}

const SESSION: AppSession = {
  email: 'member@example.com',
  roles: [],
  permissions: ['dashboard.read'],
  allowedViews: [],
  activeOrgId: ORG_A,
  memberships: [membership(ORG_A, 'org-a'), membership(ORG_B, 'org-b')],
  isStaff: false,
};

const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: SESSION, isLoading: false, getAccessToken }),
}));

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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    const [url, init] = fetchSpy.mock.calls[0]!;
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
