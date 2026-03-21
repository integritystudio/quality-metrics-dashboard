import { useState } from 'react';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { MonoTableHead } from '../components/MonoTableHead.js';
import { getSession, refreshSession } from '../lib/supabase.js';
import { API_BASE, SKELETON_HEIGHT_MD } from '../lib/constants.js';
import type { AdminUser, AdminRole } from '../lib/validation/auth-schemas.js';

const ADMIN_TABLE_COLUMNS = [
  { label: 'Email', align: 'left' as const },
  { label: 'Roles', align: 'left' as const },
  { label: 'Assign Role', align: 'left' as const },
  { label: 'Joined', align: 'right' as const },
];

async function adminFetch(path: string, method: string, body?: unknown): Promise<Response> {
  let session = getSession();
  if (!session) session = await refreshSession();
  if (!session?.access_token) throw new Error('AUTH_REQUIRED');
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

function RoleChip({
  role,
  onRevoke,
  revoking,
}: {
  role: { id: string; name: string };
  onRevoke: (roleId: string) => void;
  revoking: boolean;
}) {
  return (
    <span className="chip">
      {role.name}
      <button
        className="chip-remove"
        onClick={() => onRevoke(role.id)}
        disabled={revoking}
        aria-label={`Remove role ${role.name}`}
      >
        &times;
      </button>
    </span>
  );
}

function UserRow({
  user,
  availableRoles,
  onChanged,
}: {
  user: AdminUser;
  availableRoles: AdminRole[];
  onChanged: () => void;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const assignableRoles = availableRoles.filter(
    (r) => !user.roles.some((ur) => ur.id === r.id),
  );

  async function handleAssign() {
    if (!selectedRoleId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/users/${user.id}/roles`, 'POST', { role_id: selectedRoleId });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || 'Failed to assign role');
      } else {
        setSelectedRoleId('');
        onChanged();
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(roleId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await adminFetch(`/api/admin/users/${user.id}/roles/${roleId}`, 'DELETE');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || 'Failed to revoke role');
      } else {
        onChanged();
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b">
      <td className="cell-pad text-left">
        <span className="mono-sm">{user.email}</span>
      </td>
      <td className="cell-pad text-left">
        <div className="chip-list">
          {user.roles.length === 0 && <span className="text-muted text-xs">No roles</span>}
          {user.roles.map((r) => (
            <RoleChip key={r.id} role={r} onRevoke={handleRevoke} revoking={busy} />
          ))}
        </div>
        {error && <div className="text-xs text-error mt-1">{error}</div>}
      </td>
      <td className="cell-pad text-left">
        <div className="inline-flex-center gap-4">
          <select
            className="select-sm"
            value={selectedRoleId}
            onChange={(e) => setSelectedRoleId(e.target.value)}
            disabled={busy || assignableRoles.length === 0}
            aria-label={`Assign role to ${user.email}`}
          >
            <option value="">Select role...</option>
            {assignableRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <button
            className="btn-sm"
            onClick={handleAssign}
            disabled={busy || !selectedRoleId}
          >
            Assign
          </button>
        </div>
      </td>
      <td className="cell-pad text-right text-muted text-xs nowrap">
        {user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
      </td>
    </tr>
  );
}

export function AdminPage() {
  const [refreshKey, setRefreshKey] = useState(0);

  const { data: users, isLoading: usersLoading, error: usersError } = useApiQuery<AdminUser[]>(
    ['admin', 'users', refreshKey],
    () => `${API_BASE}/api/admin/users`,
  );

  const { data: roles, isLoading: rolesLoading, error: rolesError } = useApiQuery<AdminRole[]>(
    ['admin', 'roles'],
    () => `${API_BASE}/api/admin/roles`,
  );

  const isLoading = usersLoading || rolesLoading;
  const error = usersError ?? rolesError;

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      <DetailPageHeader title="User Management" />
      <div className="card">
        {!users || users.length === 0 ? (
          <div className="empty-state text-secondary">No users found.</div>
        ) : (
          <div className="table-scroll">
            <table className="mono-table">
              <MonoTableHead columns={ADMIN_TABLE_COLUMNS} />
              <tbody>
                {users.map((user) => (
                  <UserRow
                    key={user.id}
                    user={user}
                    availableRoles={roles ?? []}
                    onChanged={() => setRefreshKey((k) => k + 1)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PageShell>
  );
}
