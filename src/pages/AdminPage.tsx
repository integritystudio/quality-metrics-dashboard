import { useState, useRef, useCallback } from 'react';
import { format } from 'date-fns';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useAuth } from '../contexts/AuthContext.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { MonoTableHead } from '../components/MonoTableHead.js';
import { API_BASE, SKELETON_HEIGHT_MD } from '../lib/constants.js';
import type { AdminUser, AdminRole } from '../lib/validation/auth-schemas.js';

const ADMIN_TABLE_COLUMNS = [
  { label: 'Email', align: 'left' as const },
  { label: 'Roles', align: 'left' as const },
  { label: 'Assign Role', align: 'left' as const },
  { label: 'Joined', align: 'right' as const },
];

function RoleChip({
  role,
  onRevoke,
  revoking,
}: {
  role: { id: string; name: string };
  onRevoke: (roleId: string, roleName: string) => void;
  revoking: boolean;
}) {
  return (
    <span className="chip">
      {role.name}
      <button
        className="chip-remove"
        onClick={() => onRevoke(role.id, role.name)}
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
  onMutationStart,
  onMutationEnd,
}: {
  user: AdminUser;
  availableRoles: AdminRole[];
  onMutationStart: () => string;
  onMutationEnd: (id: string) => void;
}) {
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { getAccessToken } = useAuth();

  const assignableRoles = availableRoles.filter(
    (r) => !user.roles.some((ur) => ur.id === r.id),
  );

  async function adminFetch(path: string, method: string, body?: unknown): Promise<Response> {
    const token = await getAccessToken();
    return fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }

  async function handleAssign() {
    if (!selectedRoleId) return;
    setBusy(true);
    setError(null);
    const mutationId = onMutationStart();
    try {
      const res = await adminFetch(`/api/admin/users/${user.id}/roles`, 'POST', { role_id: selectedRoleId });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || 'Failed to assign role');
      } else {
        setSelectedRoleId('');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
      onMutationEnd(mutationId);
    }
  }

  async function handleRevoke(roleId: string, roleName: string) {
    if (!window.confirm(`Remove role "${roleName}" from this user?`)) return;
    setBusy(true);
    setError(null);
    const mutationId = onMutationStart();
    try {
      const res = await adminFetch(`/api/admin/users/${user.id}/roles/${roleId}`, 'DELETE');
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        setError(text || 'Failed to revoke role');
      }
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
      onMutationEnd(mutationId);
    }
  }

  return (
    <tr className="border-b">
      <td className="cell-pad text-left">
        <span className="mono-sm">{user.email ?? <span className="text-muted">(no email)</span>}</span>
      </td>
      <td className="cell-pad text-left">
        <div className="chip-list">
          {user.roles.length === 0 && <span className="text-muted text-xs">No roles</span>}
          {user.roles.map((r) => (
            <RoleChip key={r.id} role={r} onRevoke={(id, name) => void handleRevoke(id, name)} revoking={busy} />
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
            aria-label={`Assign role to ${user.email ?? user.id}`}
          >
            <option value="">Select role...</option>
            {assignableRoles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <button
            className="btn-sm"
            onClick={() => void handleAssign()}
            disabled={busy || !selectedRoleId}
          >
            Assign
          </button>
        </div>
      </td>
      <td className="cell-pad text-right text-muted text-xs nowrap">
        {user.created_at ? format(new Date(user.created_at), 'PP') : '—'}
      </td>
    </tr>
  );
}

export function AdminPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  // Replaced numeric counter with a Set of in-flight request IDs.
  // A numeric counter gets stuck if a mutation throws before onMutationEnd;
  // a Set is self-correcting — duplicate remove() calls are safe no-ops.
  const pendingMutationsRef = useRef<Set<string>>(new Set());
  const mutationIdRef = useRef(0);

  const onMutationStart = useCallback((): string => {
    const id = String(++mutationIdRef.current);
    pendingMutationsRef.current.add(id);
    return id;
  }, []);

  const onMutationEnd = useCallback((id: string) => {
    pendingMutationsRef.current.delete(id);
    if (pendingMutationsRef.current.size === 0) {
      setRefreshKey((k) => k + 1);
    }
  }, []);

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
                    onMutationStart={onMutationStart}
                    onMutationEnd={onMutationEnd}
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
