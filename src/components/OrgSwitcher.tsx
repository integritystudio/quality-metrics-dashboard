/**
 * Org switcher (P6): visible only for multi-membership users (or staff with at
 * least one membership to switch between). Persists the choice server-side via
 * POST /api/org/switch and drops the prior org's cached queries through OrgContext.
 */

import { useMutation } from '@tanstack/react-query';
import { useOrg } from '../contexts/OrgContext.js';

const SWITCH_FAILED_MESSAGE = 'Failed to switch organization';

export function OrgSwitcher() {
  const { activeOrgId, memberships, isStaff, switchOrg } = useOrg();
  const { mutate, isPending, isError } = useMutation({
    // Fail at once while offline rather than pausing the select until reconnect.
    networkMode: 'always',
    mutationFn: async (orgId: string) => {
      if (!(await switchOrg(orgId))) throw new Error(SWITCH_FAILED_MESSAGE);
    },
  });

  // Single-org users (and pre-cutover sessions with no memberships) see nothing.
  if (memberships.length < 2 && !(isStaff && memberships.length > 0)) return null;

  function handleChange(orgId: string) {
    if (!orgId || orgId === activeOrgId) return;
    mutate(orgId);
  }

  return (
    <div className="org-switcher">
      <select
        className="select-sm"
        value={activeOrgId ?? ''}
        onChange={(e) => handleChange(e.target.value)}
        disabled={isPending}
        aria-label="Switch organization"
      >
        {memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>{m.name}</option>
        ))}
      </select>
      {isError && <span className="text-xs text-error">{SWITCH_FAILED_MESSAGE}</span>}
    </div>
  );
}
