/**
 * Org switcher (P6): visible only for multi-membership users (or staff with at
 * least one membership to switch between). Persists the choice server-side via
 * POST /api/org/switch and invalidates the query cache through OrgContext.
 */

import { useState } from 'react';
import { useOrg } from '../contexts/OrgContext.js';

export function OrgSwitcher() {
  const { activeOrgId, memberships, isStaff, switchOrg } = useOrg();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Single-org users (and pre-cutover sessions with no memberships) see nothing.
  if (memberships.length < 2 && !(isStaff && memberships.length > 0)) return null;

  async function handleChange(orgId: string) {
    if (!orgId || orgId === activeOrgId) return;
    setBusy(true);
    setError(null);
    const ok = await switchOrg(orgId);
    if (!ok) setError('Failed to switch organization');
    setBusy(false);
  }

  return (
    <div className="org-switcher">
      <select
        className="select-sm"
        value={activeOrgId ?? ''}
        onChange={(e) => void handleChange(e.target.value)}
        disabled={busy}
        aria-label="Switch organization"
      >
        {memberships.map((m) => (
          <option key={m.orgId} value={m.orgId}>{m.name}</option>
        ))}
      </select>
      {error && <span className="text-xs text-error">{error}</span>}
    </div>
  );
}
