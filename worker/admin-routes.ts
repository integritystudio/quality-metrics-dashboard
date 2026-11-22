/**
 * Admin routes: org-scoped member and key management (P6) plus the legacy global user/role
 * routes. Registered by worker/index.ts after the auth middleware and before the SPA fallback,
 * so every handler here runs with a verified session.
 */

import type { Hono, MiddlewareHandler } from 'hono';
import type { PostgrestClient } from '@supabase/postgrest-js';
import type { AppSession } from '../src/types/auth.js';
import {
  AdminMemberRowSchema,
  AdminRoleSchema,
  AdminUserRoleRowSchema,
  AdminUserSchema,
  ApiKeySchema,
  AssignRoleRequestSchema,
  UpdateMemberRoleRequestSchema,
} from '../src/lib/validation/auth-schemas.js';
import { DASHBOARD_ROLE_BY_MEMBERSHIP, PERMISSION } from '../src/lib/org-rbac.js';
import { UUID_PATTERN } from '../src/lib/worker-contract.js';
import { HttpStatus } from '../src/lib/http-constants.js';
import {
  abort,
  factory,
  forbidden,
  hasPermission,
  internalError,
  readJsonBody,
  requireParam,
  safeArray,
  type AppContext,
  type AppEnv,
} from './app-context.js';
import { db, logAuditEvent, serviceRoleHeaders, SUPABASE_REST_TIMEOUT_MS, type SupabaseEnv } from './supabase.js';
import {
  ERR_ASSIGN_ROLE,
  ERR_FETCH_KEYS,
  ERR_FETCH_MEMBER,
  ERR_FETCH_MEMBERS,
  ERR_FETCH_ROLE_ASSIGNMENTS,
  ERR_FETCH_ROLES,
  ERR_FETCH_USERS,
  ERR_INVALID_KEY_ID,
  ERR_INVALID_REQUEST_BODY,
  ERR_INVALID_ROLE_ID,
  ERR_INVALID_USER_ID,
  ERR_KEY_NOT_FOUND_IN_ORG,
  ERR_REMOVE_MEMBER,
  ERR_REVOKE_ROLE,
  ERR_ROTATION_FAILED,
  ERR_UPDATE_MEMBER_ROLE,
  NO_RESPONSE_STATUS,
} from './error-messages.js';

/**
 * Org-admin gate: dashboard.admin + an org-scoped session. Binds the route to
 * session.activeOrgId, never a client parameter, so an org admin can only mutate their own org.
 */
const requireOrgAdmin = factory.createMiddleware(async (c, next) => {
  const session = c.get('session');
  if (!hasPermission(session, PERMISSION.admin) || !session.activeOrgId) {
    return forbidden(c);
  }
  c.set('orgId', session.activeOrgId);
  return next();
});

/** Only owners (or staff) may grant, downgrade, or remove an `owner` membership. */
function canTouchOwnerRole(session: AppSession): boolean {
  return session.isStaff === true || session.role === 'owner';
}

function requireUuid(param: string, error: string): MiddlewareHandler<AppEnv> {
  return requireParam(param, UUID_PATTERN, error);
}
const requireUserId = requireUuid('userId', ERR_INVALID_USER_ID);

/** The target's membership role in the active org; a failed read is a 500, a non-member a 404. */
async function targetMemberRole(c: AppContext, supabase: PostgrestClient, userId: string): Promise<string | undefined> {
  const current = await supabase.from('organization_memberships')
    .select('role')
    .eq('organization_id', c.get('orgId'))
    .eq('user_id', userId)
    .limit(1);
  if (current.error) abort(c.json({ error: ERR_FETCH_MEMBER }, HttpStatus.InternalServerError));
  const [row] = safeArray<{ role?: string }>(current.data);
  if (!row) abort(c.json({ error: ERR_INVALID_USER_ID }, HttpStatus.NotFound));
  return row.role;
}

// The global user/role routes are staff-only: dashboard.admin is an org-scoped grant and
// must not reach cross-org user_roles mutation.
const requireGlobalAdmin = factory.createMiddleware(async (c, next) => {
  if (c.get('session').isStaff !== true) return forbidden(c);
  return next();
});

/** The caller's active keys in their active org — the only keys these routes may touch. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a PostgrestFilterBuilder whose six type arguments restate postgrest-js internals; derive from the builder instead
function activeOrgKeys(env: SupabaseEnv, userId: string, orgId: string, columns: string) {
  return db(env).from('api_keys')
    .select(columns)
    .eq('user_id', userId)
    .eq('organization_id', orgId)
    .eq('status', 'active');
}

// A Supabase failure answers a generic message and a 500, never the upstream body: under the
// service role key it can carry table and column metadata.

export function registerAdminRoutes(app: Hono<AppEnv>): void {
  app.get('/api/admin/members', requireOrgAdmin, async (c) => {
    const { data, error } = await db(c.env).from('organization_memberships')
      .select('user_id,role,users(id,email)')
      .eq('organization_id', c.get('orgId'));
    if (error) return c.json({ error: ERR_FETCH_MEMBERS }, HttpStatus.InternalServerError);

    const members = [];
    for (const row of safeArray(data)) {
      const parsed = AdminMemberRowSchema.safeParse(row);
      if (!parsed.success) continue;
      members.push({
        userId: parsed.data.user_id,
        ...(parsed.data.users?.email ? { email: parsed.data.users.email } : {}),
        membershipRole: parsed.data.role,
        dashboardRole: DASHBOARD_ROLE_BY_MEMBERSHIP[parsed.data.role],
      });
    }
    return c.json(members);
  });

  app.post('/api/admin/members/:userId/role', requireOrgAdmin, requireUserId, async (c) => {
    const orgId = c.get('orgId');
    const userId = c.req.param('userId');

    const body = await readJsonBody(c.req, UpdateMemberRoleRequestSchema);
    if (!body) return c.json({ error: ERR_INVALID_REQUEST_BODY }, HttpStatus.BadRequest);
    const newRole = body.membershipRole;

    // Read the target's current role first — both granting owner and demoting an
    // existing owner are owner-only operations.
    const supabase = db(c.env);
    const currentRole = await targetMemberRole(c, supabase, userId);
    if ((newRole === 'owner' || currentRole === 'owner') && !canTouchOwnerRole(c.get('session'))) {
      return forbidden(c);
    }

    const { error } = await supabase.from('organization_memberships')
      .update({ role: newRole })
      .eq('organization_id', orgId)
      .eq('user_id', userId);
    if (error) return c.json({ error: ERR_UPDATE_MEMBER_ROLE }, HttpStatus.InternalServerError);
    logAuditEvent(c, 'member.role_change', userId, { organizationId: orgId });
    return c.body(null, HttpStatus.NoContent);
  });

  app.delete('/api/admin/members/:userId', requireOrgAdmin, requireUserId, async (c) => {
    const orgId = c.get('orgId');
    const userId = c.req.param('userId');

    const supabase = db(c.env);
    const currentRole = await targetMemberRole(c, supabase, userId);
    if (currentRole === 'owner' && !canTouchOwnerRole(c.get('session'))) {
      return forbidden(c);
    }

    const { error } = await supabase.from('organization_memberships')
      .delete()
      .eq('organization_id', orgId)
      .eq('user_id', userId);
    if (error) return c.json({ error: ERR_REMOVE_MEMBER }, HttpStatus.InternalServerError);
    logAuditEvent(c, 'member.remove', userId, { organizationId: orgId });
    return c.body(null, HttpStatus.NoContent);
  });

  app.get('/api/admin/users', requireGlobalAdmin, async (c) => {
    const supabase = db(c.env);
    const [usersRes, roleRowsRes] = await Promise.all([
      supabase.from('users').select('id,email,created_at').order('created_at', { ascending: false }),
      supabase.from('user_roles').select('user_id,role_id,roles(id,name)'),
    ]);

    if (usersRes.error) return c.json({ error: ERR_FETCH_USERS }, HttpStatus.InternalServerError);
    if (roleRowsRes.error) return c.json({ error: ERR_FETCH_ROLE_ASSIGNMENTS }, HttpStatus.InternalServerError);
    const rawUsers = safeArray(usersRes.data);
    const rawRoleRows = safeArray(roleRowsRes.data);

    const rolesByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const row of rawRoleRows) {
      const parsed = AdminUserRoleRowSchema.safeParse(row);
      if (!parsed.success || !parsed.data.roles) continue;
      const existing = rolesByUser.get(parsed.data.user_id) ?? [];
      existing.push({ id: parsed.data.roles.id, name: parsed.data.roles.name });
      rolesByUser.set(parsed.data.user_id, existing);
    }

    const users = [];
    for (const raw of rawUsers) {
      const r = raw as Record<string, unknown>;
      const parsed = AdminUserSchema.safeParse({
        id: r.id,
        email: r.email,
        created_at: r.created_at,
        roles: rolesByUser.get(r.id as string) ?? [],
      });
      if (parsed.success) users.push(parsed.data);
    }

    return c.json(users);
  });

  app.get('/api/admin/roles', requireGlobalAdmin, async (c) => {
    const { data, error } = await db(c.env).from('roles')
      .select('id,name,permissions')
      .order('name', { ascending: true });
    if (error) return c.json({ error: ERR_FETCH_ROLES }, HttpStatus.InternalServerError);

    const rows = safeArray(data);
    const roles = rows.flatMap((row) => {
      const parsed = AdminRoleSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    return c.json(roles);
  });

  app.post('/api/admin/users/:userId/roles', requireGlobalAdmin, requireUserId, async (c) => {
    const userId = c.req.param('userId');

    const body = await readJsonBody(c.req, AssignRoleRequestSchema);
    if (!body) return c.json({ error: ERR_INVALID_REQUEST_BODY }, HttpStatus.BadRequest);

    const { error } = await db(c.env).from('user_roles')
      .insert({ user_id: userId, role_id: body.role_id });
    if (error) return c.json({ error: ERR_ASSIGN_ROLE }, HttpStatus.InternalServerError);
    logAuditEvent(c, 'role.assign', userId, { roleId: body.role_id });
    return c.body(null, HttpStatus.NoContent);
  });

  app.delete('/api/admin/users/:userId/roles/:roleId', requireGlobalAdmin, requireUserId, requireUuid('roleId', ERR_INVALID_ROLE_ID), async (c) => {
    const userId = c.req.param('userId');
    const roleId = c.req.param('roleId');

    const { error } = await db(c.env).from('user_roles')
      .delete()
      .eq('user_id', userId)
      .eq('role_id', roleId);
    if (error) return c.json({ error: ERR_REVOKE_ROLE }, HttpStatus.InternalServerError);
    logAuditEvent(c, 'role.revoke', userId, { roleId });
    return c.body(null, HttpStatus.NoContent);
  });

  app.get('/api/admin/keys', requireOrgAdmin, async (c) => {
    const orgId = c.get('orgId');
    const appUserId = c.get('session').appUserId;
    if (!appUserId) return internalError(c);

    const { data, error } = await activeOrgKeys(c.env, appUserId, orgId, 'id,prefix,name,tier,status,created_at,last_used_at')
      .order('created_at', { ascending: false });
    if (error) return c.json({ error: ERR_FETCH_KEYS }, HttpStatus.InternalServerError);

    const keys = safeArray(data).flatMap((row) => {
      const parsed = ApiKeySchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    return c.json(keys);
  });

  app.post('/api/admin/keys/:keyId/rotate', requireOrgAdmin, requireUuid('keyId', ERR_INVALID_KEY_ID), async (c) => {
    const orgId = c.get('orgId');
    const appUserId = c.get('session').appUserId;
    if (!appUserId) return internalError(c);

    const keyId = c.req.param('keyId');

    const verify = await activeOrgKeys(c.env, appUserId, orgId, 'id')
      .eq('id', keyId)
      .limit(1);
    if (verify.error) return c.json({ error: ERR_ROTATION_FAILED }, HttpStatus.InternalServerError);
    if (!safeArray(verify.data).length) return c.json({ error: ERR_KEY_NOT_FOUND_IN_ORG }, HttpStatus.Forbidden);

    // Called with this worker's service key, naming the user it verified; the function
    // rechecks that the key is this user's and still active. The user's token is never
    // forwarded: the function accepts only a service-level key (verify_jwt = false), and an
    // Auth0 access token is not a Supabase credential.
    const fnRes = await fetch(
      `${c.env.SUPABASE_URL}/functions/v1/api-keys-rotate`,
      {
        method: 'POST',
        headers: serviceRoleHeaders(c.env),
        body: JSON.stringify({ keyId, userId: appUserId }),
        signal: AbortSignal.timeout(SUPABASE_REST_TIMEOUT_MS),
      },
    ).catch(() => null);

    if (!fnRes?.ok) {
      const errText = fnRes ? await fnRes.text().catch(() => '') : '';
      console.error(`[keys/rotate] function returned ${fnRes?.status ?? NO_RESPONSE_STATUS}: ${errText}`);
      return c.json({ error: ERR_ROTATION_FAILED }, HttpStatus.InternalServerError);
    }

    const result: unknown = await fnRes.json().catch(() => null);
    logAuditEvent(c, 'key.rotate', appUserId, { keyId, organizationId: orgId });
    // Return the function's response verbatim. Cache-Control: private, no-store
    // is already set by the /api/* middleware; the token must not be logged.
    return c.json(result, HttpStatus.Ok);
  });
}
