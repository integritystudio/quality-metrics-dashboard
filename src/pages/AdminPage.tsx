import { useState } from 'react';
import { format } from 'date-fns';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useOrgOptional } from '../contexts/OrgContext.js';
import { apiFetch } from '../lib/api-client.js';
import { DetailPageHeader } from '../components/DetailPageHeader.js';
import { PageShell } from '../components/PageShell.js';
import { MonoTableHead } from '../components/MonoTableHead.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';
import { RotateKeyResponseSchema, type AdminUser, type AdminRole, type AdminMember, type OrgMembershipRoleValue, type ApiKey } from '../lib/validation/auth-schemas.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../lib/http-constants.js';

// The key was rotated, so the old one no longer works, but the response carried no token to show.
const ERR_ROTATE_NO_TOKEN = 'Key rotated, but no new token was returned. Rotate it again to get one.';
const NEW_KEY_NOTICE = 'Copy it now: it is not shown again, and the old key has stopped working.';
const ERR_NETWORK = 'Network error';
const ERR_COPY_FAILED = 'Copy failed. Select the key above and copy it manually.';
const COPY_FEEDBACK_MS = 2000;

/** A rotation's new token, held above the key table: the rotated row leaves the list once it refetches. */
type RotatedKey = {
  previousPrefix: string;
  token: string;
}

const ADMIN_TABLE_COLUMNS = [
  { label: 'Email', align: 'left' as const },
  { label: 'Roles', align: 'left' as const },
  { label: 'Assign Role', align: 'left' as const },
  { label: 'Joined', align: 'right' as const },
];

const MEMBER_TABLE_COLUMNS = [
  { label: 'Email', align: 'left' as const },
  { label: 'Membership Role', align: 'left' as const },
  { label: 'Dashboard Role', align: 'left' as const },
  { label: 'Actions', align: 'right' as const },
];

const MEMBERSHIP_ROLES: OrgMembershipRoleValue[] = ['owner', 'admin', 'billing_admin', 'member', 'viewer'];

/** One key per list, so a reload after a mutation refetches in place (see useRowMutation). */
const USERS_QUERY_KEY = ['admin', 'users'] as const;
const MEMBERS_QUERY_KEY = ['admin', 'members'] as const;
const KEYS_QUERY_KEY = ['admin', 'keys'] as const;
const ADMIN_LIST_QUERY_KEYS = [USERS_QUERY_KEY, MEMBERS_QUERY_KEY, KEYS_QUERY_KEY];
/** Shared by every admin row's mutation, so the lists reload once the last in-flight one settles. */
const ADMIN_MUTATION_KEY = ['admin', 'mutation'] as const;

const KEY_TABLE_COLUMNS = [
  { label: 'Prefix', align: 'left' as const },
  { label: 'Name', align: 'left' as const },
  { label: 'Tier', align: 'left' as const },
  { label: 'Created', align: 'left' as const },
  { label: 'Last Used', align: 'left' as const },
  { label: 'Actions', align: 'right' as const },
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

/**
 * The JSON mutation fetch both admin rows use. On-choke-point (P6): it goes
 * through the shared api-client so X-Org-Id threading is single-source on the client.
 */
function useAdminFetch() {
  const { getAccessToken } = useAuth();
  const activeOrgId = useOrgOptional()?.activeOrgId ?? null;
  return async (path: string, method: string, body?: unknown): Promise<Response> => {
    const token = await getAccessToken();
    return apiFetch(path, token, activeOrgId, {
      method,
      headers: { [CONTENT_TYPE_HEADER]: ContentType.Json },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  };
}

type RowMutation = {
  path: string;
  method: string;
  body?: unknown;
  /** Shown when the response is not ok and carries no text. */
  failureMessage: string;
  /** Throw to show the thrown message as the row's error. */
  onOk?: (res: Response) => Promise<void> | void;
}

/**
 * One row's busy/error state and the mutation lifecycle every admin row shares:
 * surface the response text, the fallback message, or a network error, and
 * reload the lists once no admin mutation is still in flight.
 */
function useRowMutation() {
  const queryClient = useQueryClient();
  const activeOrgId = useOrgOptional()?.activeOrgId ?? null;
  const adminFetch = useAdminFetch();

  const mutation = useMutation({
    mutationKey: ADMIN_MUTATION_KEY,
    // The default 'online' mode pauses a mutation while the browser reports offline and
    // sends it on reconnect; a confirmed removal must fail with ERR_NETWORK instead.
    networkMode: 'always',
    mutationFn: async ({ path, method, body, failureMessage, onOk }: RowMutation) => {
      let res: Response;
      try {
        res = await adminFetch(path, method, body);
      } catch {
        throw new Error(ERR_NETWORK);
      }
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || failureMessage);
      await onOk?.(res);
    },
    onSettled: () => {
      // onSettled runs while this mutation still counts as pending, so 1 means it is the last.
      if (queryClient.isMutating({ mutationKey: ADMIN_MUTATION_KEY }) > 1) return;
      // Refetch in place, not under a new key: a new key has no data yet, so
      // PageShell would swap the table for a skeleton and unmount every row,
      // discarding the error a failed mutation just set. useApiQuery leads
      // every key with the active org.
      for (const key of ADMIN_LIST_QUERY_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [activeOrgId, ...key] });
      }
    },
  });

  return { busy: mutation.isPending, error: mutation.error?.message ?? null, run: mutation.mutate };
}

function UserRow({
  user,
  availableRoles,
}: {
  user: AdminUser;
  availableRoles: AdminRole[];
}) {
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const { busy, error, run } = useRowMutation();

  const assignableRoles = availableRoles.filter(
    (r) => !user.roles.some((ur) => ur.id === r.id),
  );

  function handleAssign() {
    if (!selectedRoleId) return;
    run({
      path: `/api/admin/users/${user.id}/roles`,
      method: 'POST',
      body: { role_id: selectedRoleId },
      failureMessage: 'Failed to assign role',
      onOk: () => setSelectedRoleId(''),
    });
  }

  function handleRevoke(roleId: string, roleName: string) {
    if (!window.confirm(`Remove role "${roleName}" from this user?`)) return;
    run({ path: `/api/admin/users/${user.id}/roles/${roleId}`, method: 'DELETE', failureMessage: 'Failed to revoke role' });
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
            <RoleChip key={r.id} role={r} onRevoke={(id, name) => handleRevoke(id, name)} revoking={busy} />
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
            onClick={() => handleAssign()}
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

function MemberRow({
  member,
  canTouchOwner,
}: {
  member: AdminMember;
  canTouchOwner: boolean;
}) {
  const [selectedRole, setSelectedRole] = useState<OrgMembershipRoleValue>(member.membershipRole);
  const { busy, error, run } = useRowMutation();

  const ownerLocked = (member.membershipRole === 'owner' || selectedRole === 'owner') && !canTouchOwner;

  function handleRoleChange() {
    if (selectedRole === member.membershipRole) return;
    run({
      path: `/api/admin/members/${member.userId}/role`,
      method: 'POST',
      body: { membershipRole: selectedRole },
      failureMessage: 'Failed to update role',
    });
  }

  function handleRemove() {
    if (!window.confirm(`Remove ${member.email ?? member.userId} from this organization?`)) return;
    run({ path: `/api/admin/members/${member.userId}`, method: 'DELETE', failureMessage: 'Failed to remove member' });
  }

  return (
    <tr className="border-b">
      <td className="cell-pad text-left">
        <span className="mono-sm">{member.email ?? <span className="text-muted">(no email)</span>}</span>
        {error && <div className="text-xs text-error mt-1">{error}</div>}
      </td>
      <td className="cell-pad text-left">
        <select
          className="select-sm"
          value={selectedRole}
          onChange={(e) => setSelectedRole(e.target.value as OrgMembershipRoleValue)}
          disabled={busy || (member.membershipRole === 'owner' && !canTouchOwner)}
          aria-label={`Membership role for ${member.email ?? member.userId}`}
        >
          {MEMBERSHIP_ROLES.map((r) => (
            <option key={r} value={r} disabled={r === 'owner' && !canTouchOwner}>{r}</option>
          ))}
        </select>
      </td>
      <td className="cell-pad text-left">
        <span className="mono-sm">{member.dashboardRole}</span>
      </td>
      <td className="cell-pad text-right">
        <div className="inline-flex-center gap-4">
          <button
            className="btn-sm"
            onClick={() => handleRoleChange()}
            disabled={busy || ownerLocked || selectedRole === member.membershipRole}
          >
            Update
          </button>
          <button
            className="btn-sm"
            onClick={() => handleRemove()}
            disabled={busy || (member.membershipRole === 'owner' && !canTouchOwner)}
          >
            Remove
          </button>
        </div>
      </td>
    </tr>
  );
}

/** The full new token with a copy button, until the admin dismisses it or leaves the page. */
function NewKeyPanel({ rotated, onDismiss }: { rotated: RotatedKey; onDismiss: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rotated.token);
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="card new-key-panel mb-4" role="status">
      <div className="text-xs mb-3">
        New key replacing <span className="mono-sm">{rotated.previousPrefix}…</span>. {NEW_KEY_NOTICE}
      </div>
      <code className="new-key-token">{rotated.token}</code>
      <div className="inline-flex-center gap-4 mt-2">
        <button className="btn-sm" onClick={() => void handleCopy()}>
          {copyState === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button className="btn-sm" onClick={onDismiss}>Done</button>
      </div>
      {copyState === 'failed' && <div className="text-xs text-error mt-1">{ERR_COPY_FAILED}</div>}
    </div>
  );
}

function KeyRow({
  apiKey,
  onRotated,
}: {
  apiKey: ApiKey;
  onRotated: (rotated: RotatedKey) => void;
}) {
  const { busy, error, run } = useRowMutation();

  function handleRotate() {
    if (!window.confirm(
      `Rotate key ${apiKey.prefix}…? The old key stops working immediately — update OBTOOL_API_KEY wherever the hooks read it.`,
    )) return;
    run({
      path: `/api/admin/keys/${apiKey.id}/rotate`,
      method: 'POST',
      failureMessage: 'Failed to rotate key',
      onOk: async (res) => {
        const parsed = RotateKeyResponseSchema.safeParse(await res.json().catch(() => null));
        if (!parsed.success) throw new Error(ERR_ROTATE_NO_TOKEN);
        onRotated({ previousPrefix: apiKey.prefix, token: parsed.data.token });
      },
    });
  }

  return (
    <tr className="border-b">
      <td className="cell-pad text-left">
        <span className="mono-sm">{apiKey.prefix}…</span>
      </td>
      <td className="cell-pad text-left">
        <span className="text-xs">{apiKey.name ?? <span className="text-muted">—</span>}</span>
      </td>
      <td className="cell-pad text-left">
        <span className="text-xs">{apiKey.tier}</span>
      </td>
      <td className="cell-pad text-left text-muted text-xs nowrap">
        {apiKey.created_at ? format(new Date(apiKey.created_at), 'PP') : '—'}
      </td>
      <td className="cell-pad text-left text-muted text-xs nowrap">
        {apiKey.last_used_at ? format(new Date(apiKey.last_used_at), 'PP') : '—'}
      </td>
      <td className="cell-pad text-right">
        <button className="btn-sm" onClick={() => handleRotate()} disabled={busy}>
          Rotate
        </button>
        {error && <div className="text-xs text-error mt-1">{error}</div>}
      </td>
    </tr>
  );
}

/**
 * Org-scoped key management: lists the caller's active keys for their active
 * org, and lets them rotate each one. A new token is held in this section's
 * state, never in localStorage or the query cache, until it is dismissed or the
 * page is left. It lives here, not in its row, because the list refetches after
 * a rotation and the revoked key's row leaves it.
 */
function ApiKeysSection() {
  const { data: keys, isLoading, error } = useApiQuery<ApiKey[]>(
    KEYS_QUERY_KEY,
    () => `/api/admin/keys`,
  );
  const [rotated, setRotated] = useState<RotatedKey | null>(null);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      <DetailPageHeader title="API Keys" />
      {rotated && <NewKeyPanel key={rotated.token} rotated={rotated} onDismiss={() => setRotated(null)} />}
      <div className="card">
        {!keys || keys.length === 0 ? (
          <div className="empty-state text-secondary">No active keys found.</div>
        ) : (
          <div className="table-scroll">
            <table className="mono-table">
              <MonoTableHead columns={KEY_TABLE_COLUMNS} />
              <tbody>
                {keys.map((k) => (
                  <KeyRow
                    key={k.id}
                    apiKey={k}
                    onRotated={setRotated}
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

/**
 * Org-scoped member management (P6): bound server-side to the session's active
 * org — this page can never read or mutate another org's memberships.
 */
function OrgMembersSection() {
  const { session } = useAuth();
  const canTouchOwner = session?.isStaff === true || session?.role === 'owner';

  const { data: members, isLoading, error } = useApiQuery<AdminMember[]>(
    MEMBERS_QUERY_KEY,
    () => `/api/admin/members`,
  );

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      <DetailPageHeader title="Organization Members" />
      <div className="card">
        {!members || members.length === 0 ? (
          <div className="empty-state text-secondary">No members found.</div>
        ) : (
          <div className="table-scroll">
            <table className="mono-table">
              <MonoTableHead columns={MEMBER_TABLE_COLUMNS} />
              <tbody>
                {members.map((member) => (
                  <MemberRow
                    key={member.userId}
                    member={member}
                    canTouchOwner={canTouchOwner}
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

export function AdminPage() {
  // Org-scoped sessions (P6) manage the ACTIVE ORG's members; the legacy
  // global user_roles table below remains for pre-cutover and staff use.
  const org = useOrgOptional();
  const activeOrgId = org?.activeOrgId ?? null;
  const orgScoped = !!activeOrgId && (org?.memberships.length ?? 0) > 0;
  const { data: users, isLoading: usersLoading, error: usersError } = useApiQuery<AdminUser[]>(
    USERS_QUERY_KEY,
    () => `/api/admin/users`,
    { enabled: !orgScoped },
  );

  const { data: roles, isLoading: rolesLoading, error: rolesError } = useApiQuery<AdminRole[]>(
    ['admin', 'roles'],
    () => `/api/admin/roles`,
    { enabled: !orgScoped },
  );

  if (orgScoped) {
    return (
      <>
        <OrgMembersSection />
        <ApiKeysSection />
      </>
    );
  }

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
