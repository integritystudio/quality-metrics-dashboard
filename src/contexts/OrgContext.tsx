/**
 * Org context (P6, org-scoped-multi-tenancy.md): the client's view of the
 * active org and its memberships.
 *
 * - activeOrgId: the chosen org — localStorage choice when still valid,
 *   otherwise the session's server-resolved activeOrg. Threaded into every
 *   React Query key (useApiQuery) and every request header (api-client).
 * - switchOrg: POST /api/org/switch (server persists default_organization_id),
 *   then invalidates the entire React Query cache so no stale prior-org data
 *   can render after a switch (Risk 10).
 *
 * Pre-cutover sessions (ORG_SCOPING_ENABLED=false) carry no org fields:
 * activeOrgId stays null, no X-Org-Id header is sent, and behavior is
 * identical to today.
 */

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from './AuthContext.js';
import { API_BASE } from '../lib/constants.js';
import { apiFetch, getStoredOrgId, setStoredOrgId } from '../lib/api-client.js';
import type { OrgMembershipSummary } from '../types/auth.js';

interface OrgContextValue {
  activeOrgId: string | null;
  memberships: OrgMembershipSummary[];
  isStaff: boolean;
  switchOrg: (orgId: string) => Promise<boolean>;
}

const OrgContext = createContext<OrgContextValue | null>(null);

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, getAccessToken } = useAuth();
  const queryClient = useQueryClient();
  const [chosenOrgId, setChosenOrgId] = useState<string | null>(() => getStoredOrgId());

  const memberships = useMemo(() => session?.memberships ?? [], [session?.memberships]);
  const isStaff = session?.isStaff ?? false;

  // A stored choice survives only while it names an org the user can still use
  // (member, or staff anywhere) — Risk 15's stale-default problem, client side.
  const activeOrgId = useMemo(() => {
    if (chosenOrgId && (isStaff || memberships.some(m => m.orgId === chosenOrgId))) {
      return chosenOrgId;
    }
    return session?.activeOrgId ?? null;
  }, [chosenOrgId, isStaff, memberships, session?.activeOrgId]);

  const switchOrg = useCallback(async (orgId: string): Promise<boolean> => {
    try {
      const token = await getAccessToken();
      const res = await apiFetch(`${API_BASE}/api/org/switch`, token, orgId, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });
      if (!res.ok) return false;
      setStoredOrgId(orgId);
      setChosenOrgId(orgId);
      // Drop every cached query — prior-org data must never render under the
      // new org, and every query key carries the org id so refetches re-scope.
      await queryClient.invalidateQueries();
      return true;
    } catch {
      return false;
    }
  }, [getAccessToken, queryClient]);

  const value = useMemo(
    () => ({ activeOrgId, memberships, isStaff, switchOrg }),
    [activeOrgId, memberships, isStaff, switchOrg],
  );
  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}

export function useOrg(): OrgContextValue {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error('useOrg must be used within an OrgProvider');
  return ctx;
}

/**
 * Nullable variant for hooks that must work outside OrgProvider (tests, e2e
 * stubs). Returns null context instead of throwing.
 */
export function useOrgOptional(): OrgContextValue | null {
  return useContext(OrgContext);
}
