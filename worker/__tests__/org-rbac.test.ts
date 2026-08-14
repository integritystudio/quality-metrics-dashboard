/**
 * Org-scoped RBAC unit tests (P5, org-scoped-multi-tenancy.md).
 *
 * The mapping table IS the auth model: these tests pin the exact permission
 * sets from the epic spec, and the two behaviors reviewers are most likely to
 * "fix" by accident — org admin gets [] views while keeping data-route access,
 * and the e2e reader gets all three views without admin.
 */

import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_ROLE_BY_MEMBERSHIP,
  PERMISSIONS_BY_DASHBOARD_ROLE,
  viewsForPermissions,
  isOrgMembershipRole,
} from '../../src/lib/org-rbac.js';

describe('DASHBOARD_ROLE_BY_MEMBERSHIP', () => {
  it('maps the five membership roles exactly per spec', () => {
    expect(DASHBOARD_ROLE_BY_MEMBERSHIP).toEqual({
      owner: 'owner',
      admin: 'admin',
      billing_admin: 'admin',
      member: 'read',
      viewer: 'e2e-dashboard-reader',
    });
  });
});

describe('PERMISSIONS_BY_DASHBOARD_ROLE', () => {
  it('owner holds every permission including admin', () => {
    const perms = PERMISSIONS_BY_DASHBOARD_ROLE.owner;
    expect(perms).toContain('dashboard.admin');
    expect(perms).toContain('dashboard.executive');
    expect(perms).toHaveLength(10);
  });

  it('admin holds admin + data reads but NO exec/operator/auditor views', () => {
    const perms = PERMISSIONS_BY_DASHBOARD_ROLE.admin;
    expect(perms).toContain('dashboard.admin');
    expect(perms).toContain('dashboard.read');
    expect(perms).toContain('dashboard.traces.read');
    expect(perms).not.toContain('dashboard.executive');
    expect(perms).not.toContain('dashboard.operator');
    expect(perms).not.toContain('dashboard.auditor');
  });

  it('read holds only dashboard.read', () => {
    expect(PERMISSIONS_BY_DASHBOARD_ROLE.read).toEqual(['dashboard.read']);
  });

  it('e2e-dashboard-reader holds everything except admin', () => {
    const perms = PERMISSIONS_BY_DASHBOARD_ROLE['e2e-dashboard-reader'];
    expect(perms).not.toContain('dashboard.admin');
    expect(perms).toContain('dashboard.executive');
    expect(perms).toContain('dashboard.operator');
    expect(perms).toContain('dashboard.auditor');
    expect(perms).toHaveLength(9);
  });
});

describe('viewsForPermissions', () => {
  it('org admin yields [] views — the dashboard.admin shortcut does not apply', () => {
    expect(viewsForPermissions(PERMISSIONS_BY_DASHBOARD_ROLE.admin)).toEqual([]);
  });

  it('owner and e2e-dashboard-reader yield all three views', () => {
    expect(viewsForPermissions(PERMISSIONS_BY_DASHBOARD_ROLE.owner)).toEqual(['executive', 'operator', 'auditor']);
    expect(viewsForPermissions(PERMISSIONS_BY_DASHBOARD_ROLE['e2e-dashboard-reader'])).toEqual(['executive', 'operator', 'auditor']);
  });

  it('read yields no views', () => {
    expect(viewsForPermissions(PERMISSIONS_BY_DASHBOARD_ROLE.read)).toEqual([]);
  });
});

describe('isOrgMembershipRole', () => {
  it('accepts the five CHECK-constrained values and rejects others', () => {
    for (const role of ['owner', 'admin', 'member', 'billing_admin', 'viewer']) {
      expect(isOrgMembershipRole(role)).toBe(true);
    }
    expect(isOrgMembershipRole('provisioned-dashboard-viewer')).toBe(false);
    expect(isOrgMembershipRole('superadmin')).toBe(false);
  });
});
