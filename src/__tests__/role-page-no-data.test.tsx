/**
 * A new org has nothing synced, and the worker answers each role view with a 404 whose
 * body is `WORKER_ERR_NO_DATA`. The role page must show the no-data state for that,
 * not the skeleton it used to fall through to and load forever.
 *
 * Runs the real `useDashboard` → `useApiQuery` → `apiFetch` stack against a stubbed
 * `fetch`, so the contract under test is the worker's actual 404 body. Any other 404
 * still errors; useApiQuery-no-data.test.tsx covers that fall-through.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { RolePage } from '../App.js';
import { WORKER_ERR_NO_DATA } from '../lib/worker-contract.js';
import type { RoleViewType } from '../types.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper, stubFetch } from './support/query-harness.js';

const ROLES: RoleViewType[] = ['executive', 'operator', 'auditor'];

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN),
    session: { allowedViews: ['executive', 'operator', 'auditor'] },
    isLoading: false,
  }),
}));

const HTTP_NOT_FOUND = 404;

function renderRolePage(role: RoleViewType) {
  return render(<RolePage role={role} period="30d" />, { wrapper: makeQueryWrapper().wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RolePage for an org with no synced data', () => {
  it.each(ROLES)('shows the no-data state on the %s view', async (role) => {
    stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HTTP_NOT_FOUND });

    renderRolePage(role);

    expect(await screen.findByText('No Evaluation Data')).toBeTruthy();
    expect(screen.queryByText('Failed to load')).toBeNull();
  });

});
