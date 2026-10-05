/**
 * Tests for AdminPage's two modes and the four admin mutations behind
 * `useAdminFetch`: assign role, remove role, change member role, remove member.
 *
 * Runs the real `useApiQuery` + react-query + `apiFetch` stack, and the real
 * `OrgProvider` in org mode. Substituted: `useAuth`, `window.confirm`, and
 * `fetch`, which is backed by an in-memory fake of the worker's admin routes so
 * a mutation's effect shows up in the list the page reloads afterwards.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminPage } from '../pages/AdminPage.js';
import { OrgProvider } from '../contexts/OrgContext.js';
import { ORG_ID_HEADER } from '../lib/worker-contract.js';
import type { AdminMember, AdminRole, AdminUser, ApiKey, OrgMembershipRoleValue } from '../lib/validation/auth-schemas.js';
import type { AppSession, DashboardRole } from '../types/auth.js';
import { TEST_ACCESS_TOKEN, headersOf, makeQueryWrapper } from './support/query-harness.js';

let currentSession: AppSession | null = null;
const getAccessToken = () => Promise.resolve(TEST_ACCESS_TOKEN);

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: currentSession, getAccessToken }),
}));

const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const ORG_ID = 'c0000000-0000-4000-8000-00000000000c';

const VIEWER: AdminRole = { id: 'e0000000-0000-4000-8000-000000000001', name: 'viewer', permissions: [] };
const OPERATOR: AdminRole = { id: 'e0000000-0000-4000-8000-000000000002', name: 'operator', permissions: [] };
const ANN: AdminUser = { id: 'd0000000-0000-4000-8000-00000000000d', email: 'ann@example.com', roles: [VIEWER] };
const BOB: AdminMember = {
  userId: 'f0000000-0000-4000-8000-00000000000f',
  email: 'bob@example.com',
  membershipRole: 'member',
  dashboardRole: 'read',
};
const OLGA: AdminMember = {
  userId: 'f0000000-0000-4000-8000-000000000010',
  email: 'olga@example.com',
  membershipRole: 'owner',
  dashboardRole: 'owner',
};

/** A session in ORG_ID whose dashboard role decides whether it may touch owners. */
function orgSession(role: DashboardRole): AppSession {
  return {
    email: 'admin@example.com',
    roles: [],
    permissions: ['dashboard.admin'],
    allowedViews: [],
    activeOrgId: ORG_ID,
    memberships: [{ orgId: ORG_ID, slug: 'acme', name: 'Acme', membershipRole: 'admin', dashboardRole: role }],
    role,
  };
}

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Refusal = { status: number; body: string } | 'network-error';

/**
 * In-memory stand-in for the worker's admin routes. GETs read the current
 * state; mutations apply to it, unless `refuse` is set, in which case they get
 * that response (or a network failure) and change nothing.
 */
const TEST_KEY_ID = 'e0000000-0000-4000-8000-000000000001';
const TEST_KEY: ApiKey = {
  id: TEST_KEY_ID,
  prefix: 'abcd1234',
  name: 'hooks-key',
  tier: 'standard',
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  last_used_at: null,
};
const NEW_TOKEN = 'obtk_newtoken00000000000000000000000000000000000000000000';
const ROTATED_KEY_ID = 'f0000000-0000-4000-8000-000000000002';

function startFakeWorker(initial: { users?: AdminUser[]; members?: AdminMember[]; keys?: ApiKey[] }) {
  const state = {
    users: structuredClone(initial.users ?? []),
    members: structuredClone(initial.members ?? []),
    keys: structuredClone(initial.keys ?? []),
  };
  const requests: RecordedRequest[] = [];
  const control: { refuse: Refusal | null } = { refuse: null };

  const json = (body: unknown) => new Response(JSON.stringify(body), {
    status: HTTP_OK,
    headers: { 'Content-Type': 'application/json' },
  });

  const routes: Array<{ method: string; pattern: RegExp; handle: (ids: string[], body: unknown) => unknown }> = [
    { method: 'GET', pattern: /^\/api\/admin\/users$/, handle: () => state.users },
    { method: 'GET', pattern: /^\/api\/admin\/roles$/, handle: () => [VIEWER, OPERATOR] },
    { method: 'GET', pattern: /^\/api\/admin\/members$/, handle: () => state.members },
    { method: 'GET', pattern: /^\/api\/admin\/keys$/, handle: () => state.keys },
    {
      method: 'POST',
      pattern: /^\/api\/admin\/keys\/([^/]+)\/rotate$/,
      handle: ([keyId]) => {
        // Keep the same key id so React reuses the component instance and the
        // newToken local state (with the copy button) persists after the list
        // refetches. Production behaviour has a new id, but that is tested via
        // the worker test; the UI test verifies that the copy-once UX works.
        state.keys = state.keys.map((k) =>
          k.id === keyId ? { ...k, prefix: 'newkey01' } : k,
        );
        return { token: NEW_TOKEN, keyId, previousKeyId: keyId, prefix: 'newkey01', tier: 'standard' };
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/admin\/users\/([^/]+)\/roles$/,
      handle: ([userId], body) => {
        const role = [VIEWER, OPERATOR].find((r) => r.id === (body as { role_id: string }).role_id)!;
        state.users.find((u) => u.id === userId)!.roles.push({ id: role.id, name: role.name });
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/admin\/users\/([^/]+)\/roles\/([^/]+)$/,
      handle: ([userId, roleId]) => {
        const user = state.users.find((u) => u.id === userId)!;
        user.roles = user.roles.filter((r) => r.id !== roleId);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/admin\/members\/([^/]+)\/role$/,
      handle: ([userId], body) => {
        state.members.find((m) => m.userId === userId)!.membershipRole =
          (body as { membershipRole: OrgMembershipRoleValue }).membershipRole;
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/admin\/members\/([^/]+)$/,
      handle: ([userId]) => { state.members = state.members.filter((m) => m.userId !== userId); },
    },
  ];

  vi.stubGlobal('fetch', vi.fn((path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, headers: headersOf(init), body });

    const refusal: Refusal | null = method === 'GET' ? null : control.refuse;
    if (refusal === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
    if (refusal) return Promise.resolve(new Response(refusal.body, { status: refusal.status }));
    for (const route of routes) {
      const match = route.method === method ? route.pattern.exec(path) : null;
      if (match) return Promise.resolve(json(route.handle(match.slice(1), body) ?? {}));
    }
    throw new Error(`fake worker has no route for ${method} ${path}`);
  }));

  return {
    control,
    mutations: () => requests.filter((r) => r.method !== 'GET'),
    requestedPaths: () => requests.map((r) => r.path),
  };
}

/**
 * Render the page and wait for its list. Org mode wraps it in the real
 * OrgProvider under `orgSession(role)`; legacy mode has no provider and no session.
 */
async function renderAdminPage(mode: { orgRole: DashboardRole } | 'legacy') {
  currentSession = mode === 'legacy' ? null : orgSession(mode.orgRole);
  const { wrapper } = makeQueryWrapper();
  render(mode === 'legacy' ? <AdminPage /> : <OrgProvider><AdminPage /></OrgProvider>, { wrapper });
  await screen.findByText(mode === 'legacy' ? ANN.email! : BOB.email!);
}

function assignRole(roleId: string) {
  fireEvent.change(screen.getByLabelText(`Assign role to ${ANN.email}`), { target: { value: roleId } });
  fireEvent.click(screen.getByRole('button', { name: 'Assign' }));
}

function changeMembershipRole(role: OrgMembershipRoleValue) {
  fireEvent.change(screen.getByLabelText(`Membership role for ${BOB.email}`), { target: { value: role } });
  fireEvent.click(screen.getByRole('button', { name: 'Update' }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  currentSession = null;
});

describe('AdminPage — user management (no active org)', () => {
  it('shows the user table with each user and their roles', async () => {
    startFakeWorker({ users: [ANN] });

    await renderAdminPage('legacy');

    expect(screen.getByText('User Management')).toBeTruthy();
    expect(screen.getByRole('button', { name: `Remove role ${VIEWER.name}` })).toBeTruthy();
  });

  it('offers only the roles the user does not already have', async () => {
    startFakeWorker({ users: [ANN] });

    await renderAdminPage('legacy');

    const options = within(screen.getByLabelText(`Assign role to ${ANN.email}`)).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Select role...', OPERATOR.name]);
  });

  it('sends an assignment as JSON with the admin token and no org header', async () => {
    const worker = startFakeWorker({ users: [ANN] });
    await renderAdminPage('legacy');

    assignRole(OPERATOR.id);

    await waitFor(() => { expect(worker.mutations()).toHaveLength(1); });
    const [request] = worker.mutations();
    expect(request).toMatchObject({
      method: 'POST',
      path: `/api/admin/users/${ANN.id}/roles`,
      body: { role_id: OPERATOR.id },
    });
    expect(request!.headers).toMatchObject({
      Authorization: `Bearer ${TEST_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    });
    expect(request!.headers).not.toHaveProperty(ORG_ID_HEADER);
  });

  it('shows the assigned role once the list reloads', async () => {
    startFakeWorker({ users: [ANN] });
    await renderAdminPage('legacy');

    assignRole(OPERATOR.id);

    expect(await screen.findByRole('button', { name: `Remove role ${OPERATOR.name}` })).toBeTruthy();
  });

  // The assigned role leaves the picker's options, so the picker reads empty either
  // way; a stale selection shows up only as an Assign button that would send it again.
  it('clears the selection after an assignment, so it cannot be sent twice', async () => {
    startFakeWorker({ users: [ANN] });
    await renderAdminPage('legacy');

    assignRole(OPERATOR.id);

    await screen.findByRole('button', { name: `Remove role ${OPERATOR.name}` });
    expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled();
  });

  it('removes a role after the admin confirms', async () => {
    const worker = startFakeWorker({ users: [ANN] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage('legacy');

    fireEvent.click(screen.getByRole('button', { name: `Remove role ${VIEWER.name}` }));

    expect(await screen.findByText('No roles')).toBeTruthy();
    expect(worker.mutations()).toMatchObject([
      { method: 'DELETE', path: `/api/admin/users/${ANN.id}/roles/${VIEWER.id}` },
    ]);
  });
});

describe('AdminPage — organization members (active org)', () => {
  it('shows the members of the active org instead of the user table', async () => {
    const worker = startFakeWorker({ members: [BOB] });

    await renderAdminPage({ orgRole: 'admin' });

    expect(screen.getByText('Organization Members')).toBeTruthy();
    expect(worker.requestedPaths()).not.toContain('/api/admin/users');
  });

  it('keeps Update disabled until a different role is chosen', async () => {
    startFakeWorker({ members: [BOB] });

    await renderAdminPage({ orgRole: 'admin' });

    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
  });

  it('sends a role change under the active org', async () => {
    const worker = startFakeWorker({ members: [BOB] });
    await renderAdminPage({ orgRole: 'admin' });

    changeMembershipRole('admin');

    await waitFor(() => { expect(worker.mutations()).toHaveLength(1); });
    const [request] = worker.mutations();
    expect(request).toMatchObject({
      method: 'POST',
      path: `/api/admin/members/${BOB.userId}/role`,
      body: { membershipRole: 'admin' },
    });
    expect(request!.headers[ORG_ID_HEADER]).toBe(ORG_ID);
  });

  it('disables Update again once the list reloads with the new role', async () => {
    startFakeWorker({ members: [BOB] });
    await renderAdminPage({ orgRole: 'admin' });

    changeMembershipRole('admin');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    });
  });

  it('removes a member after the admin confirms', async () => {
    const worker = startFakeWorker({ members: [BOB] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByText('No members found.')).toBeTruthy();
    expect(worker.mutations()).toMatchObject([{ method: 'DELETE', path: `/api/admin/members/${BOB.userId}` }]);
  });

  it('does not let a non-owner change or remove an owner', async () => {
    startFakeWorker({ members: [BOB, OLGA] });

    await renderAdminPage({ orgRole: 'admin' });

    const olgaRow = screen.getByText(OLGA.email!).closest('tr')!;
    expect(within(olgaRow).getByRole('combobox')).toBeDisabled();
    expect(within(olgaRow).getByRole('button', { name: 'Remove' })).toBeDisabled();
  });

  it('lets an owner change or remove another owner', async () => {
    startFakeWorker({ members: [BOB, OLGA] });

    await renderAdminPage({ orgRole: 'owner' });

    const olgaRow = screen.getByText(OLGA.email!).closest('tr')!;
    expect(within(olgaRow).getByRole('combobox')).toBeEnabled();
    expect(within(olgaRow).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });
});

interface MutationCase {
  name: string;
  mode: { orgRole: DashboardRole } | 'legacy';
  members?: AdminMember[];
  /** Drive the UI until the mutation request is sent. */
  perform: () => void;
  defaultError: string;
}

const MUTATIONS: MutationCase[] = [
  {
    name: 'assigning a role',
    mode: 'legacy',
    perform: () => assignRole(OPERATOR.id),
    defaultError: 'Failed to assign role',
  },
  {
    name: 'removing a role',
    mode: 'legacy',
    perform: () => fireEvent.click(screen.getByRole('button', { name: `Remove role ${VIEWER.name}` })),
    defaultError: 'Failed to revoke role',
  },
  {
    name: 'changing a member role',
    mode: { orgRole: 'admin' },
    perform: () => changeMembershipRole('admin'),
    defaultError: 'Failed to update role',
  },
  {
    name: 'removing a member',
    mode: { orgRole: 'admin' },
    perform: () => fireEvent.click(screen.getByRole('button', { name: 'Remove' })),
    defaultError: 'Failed to remove member',
  },
];

describe('AdminPage — refused and failed mutations', () => {
  async function renderWithRefusal({ mode }: MutationCase, refusal: Refusal) {
    const worker = startFakeWorker({ users: [ANN], members: [BOB] });
    worker.control.refuse = refusal;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage(mode);
  }

  it.each(MUTATIONS)('shows the worker\'s error text when $name is refused', async (mutation) => {
    await renderWithRefusal(mutation, { status: HTTP_FORBIDDEN, body: 'Forbidden: not your org' });

    mutation.perform();

    expect(await screen.findByText('Forbidden: not your org')).toBeTruthy();
  });

  it.each(MUTATIONS)('shows "$defaultError" when $name is refused with an empty body', async (mutation) => {
    await renderWithRefusal(mutation, { status: HTTP_FORBIDDEN, body: '' });

    mutation.perform();

    expect(await screen.findByText(mutation.defaultError)).toBeTruthy();
  });

  it.each(MUTATIONS)('shows a network error when $name cannot be sent', async (mutation) => {
    await renderWithRefusal(mutation, 'network-error');

    mutation.perform();

    expect(await screen.findByText('Network error')).toBeTruthy();
  });
});

/**
 * A removal that goes ahead disables its row's buttons synchronously, before the
 * request leaves (the token fetch comes first). So "still enabled" is what tells a
 * cancel apart right after the click; "no request" alone would pass too early to mean anything.
 */
describe('AdminPage — cancelled removals', () => {
  it('leaves a role alone when the admin cancels its removal', async () => {
    const worker = startFakeWorker({ users: [ANN] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderAdminPage('legacy');
    const remove = screen.getByRole('button', { name: `Remove role ${VIEWER.name}` });

    fireEvent.click(remove);

    expect(remove).toBeEnabled();
    expect(worker.mutations()).toEqual([]);
  });

  it('leaves a member alone when the admin cancels their removal', async () => {
    const worker = startFakeWorker({ members: [BOB] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderAdminPage({ orgRole: 'admin' });
    const remove = screen.getByRole('button', { name: 'Remove' });

    fireEvent.click(remove);

    expect(remove).toBeEnabled();
    expect(worker.mutations()).toEqual([]);
  });
});

describe('AdminPage — API keys section (org mode)', () => {
  it('shows the key prefix and a Rotate button', async () => {
    startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    await renderAdminPage({ orgRole: 'admin' });

    expect(await screen.findByText(`${TEST_KEY.prefix}…`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeTruthy();
  });

  it('shows the new token once after a confirmed rotation', async () => {
    startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText(NEW_TOKEN.slice(0, 16) + '…')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    // Rotate button is gone — replaced by the token display
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull();
  });

  it('sends the rotation to the correct route with org header', async () => {
    const worker = startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    await waitFor(() => { expect(worker.mutations()).toHaveLength(1); });
    const [req] = worker.mutations();
    expect(req).toMatchObject({
      method: 'POST',
      path: `/api/admin/keys/${TEST_KEY_ID}/rotate`,
    });
    expect(req!.headers[ORG_ID_HEADER]).toBe(ORG_ID);
  });

  it('leaves the Rotate button when the admin cancels the confirmation', async () => {
    startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    await screen.findByText(`${TEST_KEY.prefix}…`);
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeEnabled();
  });

  it('shows an error when rotation is refused by the worker', async () => {
    const worker = startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    worker.control.refuse = { status: HTTP_FORBIDDEN, body: 'Key not found in active org' };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('Key not found in active org')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotate' })).toBeEnabled();
  });

  it('shows a fallback error when rotation is refused with empty body', async () => {
    const worker = startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    worker.control.refuse = { status: HTTP_FORBIDDEN, body: '' };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('Failed to rotate key')).toBeTruthy();
  });

  it('shows a network error when the rotation request cannot be sent', async () => {
    const worker = startFakeWorker({ members: [BOB], keys: [TEST_KEY] });
    worker.control.refuse = 'network-error';
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await renderAdminPage({ orgRole: 'admin' });

    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));

    expect(await screen.findByText('Network error')).toBeTruthy();
  });
});
