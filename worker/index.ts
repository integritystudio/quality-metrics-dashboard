import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { DashboardPermission, AppSession, DashboardView, OrgMembershipSummary } from '../src/types/auth.js';
import type { UserActivityEvent } from '../src/types/activity.js';
import { PublicUserSchema, UserRoleRowSchema, MeResponseSchema, ActivityRequestSchema, AdminRoleSchema, AdminUserRoleRowSchema, AdminUserSchema, AssignRoleRequestSchema, OrgMembershipRowSchema, OrgSwitchRequestSchema, AdminMemberRowSchema, UpdateMemberRoleRequestSchema } from '../src/lib/validation/auth-schemas.js';
import { DASHBOARD_ROLE_BY_MEMBERSHIP, PERMISSIONS_BY_DASHBOARD_ROLE, viewsForPermissions } from '../src/lib/org-rbac.js';
import { routingTelemetryKvSchema, calibrationResponseSchema } from '../src/lib/validation/dashboard-schemas.js';
import { supabasePost } from '../src/lib/supabase-rest.js';

export type { DashboardPermission, AppSession };

const Http = {
  Ok: 200,
  NoContent: 204,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  InternalServerError: 500,
} as const satisfies Record<string, number>;

const VALID_PERIOD_KEYS = ['24h', '7d', '30d'] as const;
const ERR_INVALID_PERIOD = 'Invalid period. Must be 24h, 7d, or 30d.';

const VALID_SORT_BY = ['timestamp_desc', 'score_asc', 'score_desc'] as const;
const ERR_INVALID_SORT_BY = 'Invalid sortBy. Must be timestamp_desc, score_asc, or score_desc.';

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const ERR_INVALID_PAGINATION = 'Invalid pagination params. limit must be 1–200, offset must be >= 0.';

const ERR_UNAUTHORIZED = 'Unauthorized';
const ERR_FORBIDDEN = 'Forbidden';
const ERR_INVALID_REQUEST_BODY = 'Invalid request body';
const ERR_INVALID_METRIC_NAME = 'Invalid metric name';
const ERR_INVALID_TRACE_ID = 'Invalid traceId';
const ERR_INVALID_SESSION_ID = 'Invalid sessionId';
const ERR_INVALID_AGENT_ID = 'Invalid agentId';

const VALID_ROLES = ['executive', 'operator', 'auditor'] as const;
const ERR_INVALID_ROLE = 'Invalid role. Must be executive, operator, or auditor.';

const VALID_INPUT_KEYS = ['traceId', 'sessionId'] as const;
const ERR_INVALID_INPUT_KEY = 'Invalid inputKey. Must be traceId or sessionId.';
const ERR_INVALID_USER_ID = 'Invalid userId';
const ERR_INVALID_ROLE_ID = 'Invalid roleId';
const ERR_INTERNAL = 'Internal server error';
const ERR_NO_ORG = 'No organization membership';
const ERR_NO_DATA = 'No data available';
const ERR_NO_CALIBRATION_DATA = 'No calibration data available';
const ERR_ROUTING_TELEMETRY_MALFORMED = 'Routing telemetry data is malformed';
const ERR_CALIBRATION_MALFORMED = 'Calibration data is malformed';
const ERR_FAILED_LOAD_USER_ROLES = 'Failed to load user roles';

const KV_SCHEMA_VERSION = 1;

const PARAM_RE = /^[\w:.-]+$/;
const MAX_PARAM_LEN = 200;
function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? val as T[] : [];
}
function isValidId(id: string | undefined): id is string {
  return !!id && id.length <= MAX_PARAM_LEN && PARAM_RE.test(id);
}

// Reads a KV entry and unwraps the { v, data } version envelope written by sync-to-kv.ts.
// - Versioned entries (v === KV_SCHEMA_VERSION): returns data field.
// - Version mismatch: logs a warning and returns null (stale cache treated as missing).
// - Legacy entries (no envelope): passes through as-is for backwards compatibility.
// Private: routes go through getKv (org choke point) or getGlobalKv (allowlist).
async function readKvEnvelope<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw: unknown = await kv.get(key, 'json');
  if (raw === null) return null;
  if (typeof raw === 'object' && 'v' in raw && 'data' in raw) {
    const envelope = raw;
    if (envelope.v !== KV_SCHEMA_VERSION) {
      console.warn(`[kv] schema version mismatch for "${key}": expected ${KV_SCHEMA_VERSION}, got ${String(envelope.v)} — treating as missing`);
      return null;
    }
    return envelope.data as T;
  }
  // Legacy entry (no envelope): pass through unchanged.
  return raw as T;
}

/**
 * Fallback-hit counter (P5 instrumentation, Risk 20). P7's cutover verdict is
 * "kv_fallback_hits ≈ 0 over the soak window" — read it from worker logs.
 */
let kvFallbackHits = 0;

type OrgKvEnv = { HOME_ORG_ID?: string; ORG_KV_FALLBACK_DISABLED?: string };

/**
 * The single org-scoped KV choke point (org-scoped-multi-tenancy.md, P5).
 * - orgId null: legacy bare-key read — the ORG_SCOPING_ENABLED=false path and
 *   the legacy user_roles fallback, byte-identical to pre-tenancy behavior.
 * - orgId set: reads `org:<orgId>:<key>`; on a miss, an env-gated dual-read
 *   fallback to the bare key applies to the HOME org ONLY (Risk 6 — a fresh,
 *   un-synced tenant org must never fall back into the owner's global data).
 *   Every fallback hit increments kv_fallback_hits. P8 removes the fallback.
 */
async function getKv<T>(kv: KVNamespace, orgId: string | null, key: string, env: OrgKvEnv): Promise<T | null> {
  if (!orgId) return readKvEnvelope<T>(kv, key);
  const scoped = await readKvEnvelope<T>(kv, `org:${orgId}:${key}`);
  if (scoped !== null) return scoped;
  if (env.ORG_KV_FALLBACK_DISABLED !== 'true' && env.HOME_ORG_ID && orgId === env.HOME_ORG_ID) {
    const legacy = await readKvEnvelope<T>(kv, key);
    if (legacy !== null) {
      kvFallbackHits++;
      console.log(`[kv] kv_fallback_hits=${kvFallbackHits} key="${key}" (bare-key fallback, home org)`);
      return legacy;
    }
  }
  return null;
}

/**
 * Intentionally-global system keys, readable without a session. The explicit
 * allowlist is what the P8 choke-point guard recognizes — any other unprefixed
 * read is a defect, not an exception.
 */
const GLOBAL_KV_ALLOWLIST = new Set(['system:lastSync']);

async function getGlobalKv<T>(kv: KVNamespace, key: string): Promise<T | null> {
  if (!GLOBAL_KV_ALLOWLIST.has(key)) {
    console.error(`[kv] getGlobalKv called with non-allowlisted key "${key}" — refusing`);
    return null;
  }
  return readKvEnvelope<T>(kv, key);
}

type AuditAction = 'role.assign' | 'role.revoke' | 'member.role_change' | 'member.remove';
type SupabaseEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };
type WaitUntilFn = (promise: Promise<unknown>) => void;

// Fire-and-forget: logs sensitive admin mutations to audit_log without blocking the response.
// No-ops when actorUserId is absent; otherwise only fires on success (not on upstream Supabase failure).
// organizationId (P6): org-admin mutations always record session.activeOrgId, so an
// audit row can never claim a scope the mutation did not have. Requires the
// `ALTER TABLE audit_log ADD COLUMN organization_id uuid` migration; supabasePost
// swallows the PostgREST error until that lands (fire-and-forget by design).
function logAuditEvent(
  actorUserId: string | undefined,
  action: AuditAction,
  targetUserId: string,
  roleId: string | undefined,
  env: SupabaseEnv,
  waitUntil: WaitUntilFn,
  organizationId?: string,
): void {
  if (!actorUserId) return;
  waitUntil(supabasePost(
    `${env.SUPABASE_URL}/rest/v1/audit_log`,
    {
      actor_user_id: actorUserId,
      action,
      target_user_id: targetUserId,
      // Member mutations carry no role uuid — the membership role change is
      // implied by the action + org scope; role_id stays a uuid-only column.
      ...(roleId !== undefined && { role_id: roleId }),
      ...(organizationId !== undefined && { organization_id: organizationId }),
    },
    env.SUPABASE_SERVICE_ROLE_KEY,
  ));
}

// Fire-and-forget: logs activity to user_activity table without blocking the response.
// Failures are intentionally swallowed — audit logging must not fail user requests.
// Auth: uses service role key (Auth0 JWTs are not valid Supabase session tokens for RLS).
// waitUntil: CF ExecutionContext.waitUntil — required to prevent the Worker runtime from
// cancelling the in-flight fetch after the response is sent.
function logActivity(
  appUserId: string | undefined,
  activityType: UserActivityEvent,
  env: SupabaseEnv,
  waitUntil: WaitUntilFn,
): void {
  if (!appUserId) return;
  waitUntil(supabasePost(
    `${env.SUPABASE_URL}/rest/v1/user_activity`,
    { user_id: appUserId, activity_type: activityType },
    env.SUPABASE_SERVICE_ROLE_KEY,
  ));
}

const VIEW_PERMISSION_MAP: Array<[DashboardPermission, DashboardView]> = [
  ['dashboard.executive', 'executive'],
  ['dashboard.operator', 'operator'],
  ['dashboard.auditor', 'auditor'],
];

// Mirror of client-side VALID_PERMISSIONS — filters DB permission strings before
// trusting them as DashboardPermission values in the session.
const VALID_PERMISSIONS = new Set<string>([
  'dashboard.read',
  'dashboard.executive',
  'dashboard.operator',
  'dashboard.auditor',
  'dashboard.traces.read',
  'dashboard.sessions.read',
  'dashboard.agents.read',
  'dashboard.pipeline.read',
  'dashboard.compliance.read',
  'dashboard.admin',
] satisfies DashboardPermission[]);

type Bindings = {
  DASHBOARD: KVNamespace;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  // Service role key for all Supabase DB calls (Auth0 JWTs cannot satisfy Supabase RLS).
  // Set via: wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_SERVICE_ROLE_KEY: string;
  AUTH0_DOMAIN: string;    // e.g. "integritystudio.us.auth0.com"
  AUTH0_AUDIENCE: string;  // e.g. "https://api.integritystudio.dev"
  // Must be explicitly set to 'true' to enable the test-token bypass.
  // Never set this in production wrangler.toml — leave absent.
  ALLOW_TEST_BYPASS?: string;
  // --- Org-scoped multi-tenancy (P5) ---
  // Gates org resolution + getKv prefixing. Deployed 'false' until the P7 cutover.
  ORG_SCOPING_ENABLED?: string;
  // Org owning all pre-tenancy data. Non-empty on both production workers,
  // deliberately '' on quality-metrics-api-dev (must fail loudly, never resolve
  // a production org).
  HOME_ORG_ID?: string;
  // JSON array of app user UUIDs — the explicit staff allowlist (decision Q2).
  STAFF_USER_IDS?: string;
  // Set 'true' at P8 to switch off the home-org bare-key dual-read fallback.
  ORG_KV_FALLBACK_DISABLED?: string;
};

type Variables = {
  session: AppSession;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('/*', cors({
  origin: [
    'https://integritystudio.dev',
    'https://www.aledlie.com',
    'https://aledlie.com',
    // Localhost origins for local dev (npm run dev hits deployed worker)
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  // GET, POST, and DELETE are allowed. Bearer JWT auth on all /api/* routes prevents CSRF —
  // browsers cannot set custom Authorization headers in cross-site requests.
  allowMethods: ['GET', 'POST', 'DELETE'],
  // X-Org-Id carries the client's chosen active org (P5/P6); membership-validated
  // server-side in the auth middleware, never trusted as-is.
  allowHeaders: ['Authorization', 'Content-Type', 'X-Org-Id'],
}));

// Cache policy: private, no-store for all /api/* (responses may contain user-specific data)
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

const AUTH_TIMEOUT_MS = 5000;

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();

  const authHeader = c.req.header('Authorization');
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Test mode: bypass auth when ALLOW_TEST_BYPASS is explicitly enabled in the environment.
  // Never set ALLOW_TEST_BYPASS in production — leave the binding absent.
  if (c.env.ALLOW_TEST_BYPASS === 'true' && jwt === 'test-token') {
    // Phase-gate assertion (P5, Q7): refuse the bypass outright when a
    // production env marker is present. HOME_ORG_ID and STAFF_USER_IDS carry
    // real values only on the two production workers (dev deliberately holds
    // '' / '[]'), so either being set means this binding leaked into prod.
    if ((c.env.HOME_ORG_ID ?? '') !== '' || parseStaffIds(c.env.STAFF_USER_IDS).size > 0) {
      console.error('[auth] ALLOW_TEST_BYPASS refused: production env markers present (HOME_ORG_ID/STAFF_USER_IDS)');
      return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);
    }
    const bypassOrgId = 'a0000000-0000-4000-8000-000000000001';
    c.set('session', {
      authUserId: 'auth0|test-user',
      appUserId: 'a0000000-0000-4000-8000-000000000002',
      email: 'test@example.com',
      roles: ['test'],
      permissions: ['dashboard.admin'],
      allowedViews: [...VALID_ROLES],
      // Org context (P5): the bypass session carries the org-scoped shape so
      // e2e fixtures and the session contract change in the same phase.
      activeOrgId: bypassOrgId,
      memberships: [{
        orgId: bypassOrgId,
        slug: 'test-org',
        name: 'Test Org',
        membershipRole: 'owner',
        dashboardRole: 'owner',
      }],
      role: 'owner',
      isStaff: false,
    });
    return next();
  }

  if (!jwt) return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);

  // Single AbortController shared across all auth fetches; aborts on timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    const JWKS = createRemoteJWKSet(
      new URL(`https://${c.env.AUTH0_DOMAIN}/.well-known/jwks.json`),
    );
    let jwtPayload: Record<string, unknown>;
    try {
      const { payload } = await jwtVerify(jwt, JWKS, {
        issuer: `https://${c.env.AUTH0_DOMAIN}/`,
        audience: c.env.AUTH0_AUDIENCE,
      });
      jwtPayload = payload;
    } catch {
      return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);
    }
    const auth0Id = typeof jwtPayload['sub'] === 'string' ? jwtPayload['sub'] : null;
    if (!auth0Id) return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);

    const orgScopingEnabled = c.env.ORG_SCOPING_ENABLED === 'true';
    if (orgScopingEnabled && !c.env.HOME_ORG_ID) {
      // Fail loudly: an empty HOME_ORG_ID (the dev worker's deliberate value)
      // must never silently resolve or fall back into a production org.
      console.error('[auth] ORG_SCOPING_ENABLED=true but HOME_ORG_ID is empty — refusing to serve');
      return c.json({ error: ERR_INTERNAL }, Http.InternalServerError);
    }

    // Fetch public.users row by auth0_id — required; users with no app record are rejected
    const userRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/users?select=id,email,default_organization_id&auth0_id=eq.${encodeURIComponent(auth0Id)}&limit=1`,
      { headers: serviceRoleHeaders(c.env), signal: controller.signal },
    ).catch(() => null);
    if (!userRes?.ok) return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);
    const rawUsers: unknown = await userRes.json().catch(() => null);
    if (!Array.isArray(rawUsers) || !rawUsers[0]) return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);
    const userResult = PublicUserSchema.safeParse(rawUsers[0]);
    if (!userResult.success) return c.json({ error: ERR_UNAUTHORIZED }, Http.Unauthorized);
    const appUserId = userResult.data.id;
    const email = userResult.data.email;
    const defaultOrgId = userResult.data.default_organization_id ?? null;
    const authUserId = auth0Id;

    // Roles and (under org scoping) memberships fetch in PARALLEL — Risk 19:
    // the added membership round-trip must not serialize into the auth budget.
    const rolesPromise = fetch(
      `${c.env.SUPABASE_URL}/rest/v1/user_roles?select=roles(name,permissions)&user_id=eq.${encodeURIComponent(appUserId)}`,
      { headers: serviceRoleHeaders(c.env), signal: controller.signal },
    ).catch(() => null);
    const membershipsPromise = orgScopingEnabled
      ? fetch(
          `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?select=role,organization_id,organizations(id,slug,name)&user_id=eq.${encodeURIComponent(appUserId)}`,
          { headers: serviceRoleHeaders(c.env), signal: controller.signal },
        ).catch(() => null)
      : Promise.resolve(null);
    const [rolesRes, membershipsRes] = await Promise.all([rolesPromise, membershipsPromise]);

    if (!rolesRes?.ok) {
      console.error('[auth] role fetch failed for user', appUserId, 'status:', rolesRes?.status ?? 'network error');
      return c.json({ error: ERR_FAILED_LOAD_USER_ROLES }, Http.InternalServerError);
    }
    const rawRows: unknown = await rolesRes.json().catch(() => []);
    const rows = safeArray(rawRows);
    const roles: string[] = [];
    const permissionSet = new Set<DashboardPermission>();
    for (const row of rows) {
      const rowResult = UserRoleRowSchema.safeParse(row);
      if (!rowResult.success || !rowResult.data.roles) continue;
      roles.push(rowResult.data.roles.name);
      for (const perm of rowResult.data.roles.permissions) {
        if (VALID_PERMISSIONS.has(perm)) permissionSet.add(perm as DashboardPermission);
      }
    }

    if (orgScopingEnabled) {
      const memberships = parseMemberships(membershipsRes ? await membershipsRes.json().catch(() => []) : []);
      const isStaff = parseStaffIds(c.env.STAFF_USER_IDS).has(appUserId);

      // Resolve activeOrgId: X-Org-Id (membership-validated, or staff) →
      // default_organization_id (re-validated — Risk 15) → first membership.
      const requestedOrg = c.req.header('X-Org-Id');
      let activeOrgId: string | undefined;
      if (requestedOrg) {
        if (!UUID_PATTERN.test(requestedOrg)) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
        if (!isStaff && !memberships.some(m => m.orgId === requestedOrg)) {
          return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
        }
        activeOrgId = requestedOrg;
      }
      if (!activeOrgId && defaultOrgId && (isStaff || memberships.some(m => m.orgId === defaultOrgId))) {
        activeOrgId = defaultOrgId;
      }
      activeOrgId ??= memberships[0]?.orgId;
      if (!activeOrgId && isStaff) activeOrgId = c.env.HOME_ORG_ID;

      if (activeOrgId) {
        const membership = memberships.find(m => m.orgId === activeOrgId);
        const role = isStaff ? 'owner' : membership?.dashboardRole ?? 'read';
        const permissions = [...PERMISSIONS_BY_DASHBOARD_ROLE[role]];
        // No dashboard.admin → all-views shortcut on the org path: an org admin
        // gets [] views but keeps data-route access via hasPermission (spec).
        const allowedViews = viewsForPermissions(permissions);
        c.set('session', { authUserId, appUserId, email, roles, permissions, allowedViews, activeOrgId, memberships, role, isStaff });
        return next();
      }

      // Legacy fallback (Risk 13, no lockout): a user with no membership but
      // with user_roles rows resolves via the old global path — bare-key reads,
      // legacy permission derivation, no org fields on the session.
      if (roles.length === 0) {
        return c.json({ error: ERR_NO_ORG }, Http.Forbidden);
      }
    }

    const permissions = [...permissionSet];
    const allowedViews: DashboardView[] = permissionSet.has('dashboard.admin')
      ? [...VALID_ROLES]
      : VIEW_PERMISSION_MAP
          .filter(([perm]) => permissionSet.has(perm))
          .map(([, view]: [DashboardPermission, DashboardView]) => view);

    c.set('session', { authUserId, appUserId, email, roles, permissions, allowedViews });
    return next();
  } finally {
    clearTimeout(timeout);
  }
});

/** Parse the STAFF_USER_IDS env (JSON array of app user UUIDs) — fail closed on malformed input. */
function parseStaffIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    console.error('[auth] STAFF_USER_IDS is not valid JSON — treating as empty allowlist');
    return new Set();
  }
}

/** Validate + map organization_memberships rows into session summaries. */
function parseMemberships(raw: unknown): OrgMembershipSummary[] {
  const memberships: OrgMembershipSummary[] = [];
  for (const row of safeArray(raw)) {
    const parsed = OrgMembershipRowSchema.safeParse(row);
    if (!parsed.success || !parsed.data.organizations) continue;
    memberships.push({
      orgId: parsed.data.organizations.id,
      slug: parsed.data.organizations.slug,
      name: parsed.data.organizations.name,
      membershipRole: parsed.data.role,
      dashboardRole: DASHBOARD_ROLE_BY_MEMBERSHIP[parsed.data.role],
    });
  }
  return memberships;
}

function hasPermission(session: AppSession, permission: DashboardPermission): boolean {
  return session.permissions.includes('dashboard.admin') || session.permissions.includes(permission);
}

type AppContext = {
  env: Bindings;
  get: (key: 'session') => AppSession;
};

/**
 * Session-scoped KV read used by every /api/* data route. With
 * ORG_SCOPING_ENABLED=false (or a legacy-fallback session carrying no
 * activeOrgId) this is a bare-key read — today's behavior, unchanged.
 */
function getSessionKv<T>(c: AppContext, key: string): Promise<T | null> {
  const orgId = c.env.ORG_SCOPING_ENABLED === 'true'
    ? c.get('session').activeOrgId ?? null
    : null;
  return getKv<T>(c.env.DASHBOARD, orgId, key, c.env);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Both apikey and Authorization use the service role key — the anon key is for browser clients only.
function serviceRoleHeaders(env: { SUPABASE_SERVICE_ROLE_KEY: string }): HeadersInit {
  return {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Explicitly construct the me payload to avoid exposing internal IDs
// (authUserId, appUserId). Org fields appear only on org-scoped sessions.
function buildMePayload(session: AppSession): Record<string, unknown> {
  return {
    email: session.email,
    roles: session.roles,
    permissions: session.permissions,
    allowedViews: session.allowedViews,
    ...(session.activeOrgId !== undefined && { activeOrg: session.activeOrgId }),
    ...(session.memberships !== undefined && { memberships: session.memberships }),
    ...(session.role !== undefined && { role: session.role }),
    ...(session.isStaff !== undefined && { isStaff: session.isStaff }),
  };
}

app.get('/api/me', (c) => {
  const meResult = MeResponseSchema.safeParse(buildMePayload(c.get('session')));
  if (!meResult.success) {
    console.error('[/api/me] MeResponseSchema validation failed:', meResult.error.issues);
    return c.json({ error: ERR_INTERNAL }, Http.InternalServerError);
  }
  return c.json(meResult.data);
});

// Switch the active org: membership-validated (or staff), persisted as the
// user's default_organization_id, and echoed back as an updated me payload.
// Under ORG_SCOPING_ENABLED=false sessions carry no memberships, so this
// naturally 403s — the route is inert until cutover.
app.post('/api/org/switch', async (c) => {
  const session = c.get('session');
  const body: unknown = await c.req.json().catch(() => null);
  const result = OrgSwitchRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: ERR_INVALID_REQUEST_BODY }, Http.BadRequest);
  const { orgId } = result.data;

  if (!session.isStaff && !session.memberships?.some(m => m.orgId === orgId)) {
    return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  }
  if (session.appUserId) {
    const res = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(session.appUserId)}`,
      {
        method: 'PATCH',
        headers: { ...(serviceRoleHeaders(c.env) as Record<string, string>), 'Prefer': 'return=minimal' },
        body: JSON.stringify({ default_organization_id: orgId }),
      },
    ).catch(() => null);
    if (!res?.ok) return c.json({ error: ERR_INTERNAL }, Http.InternalServerError);
  }

  // Recompute the org-dependent session fields for the response; the next
  // request re-resolves fully at the middleware.
  const membership = session.memberships?.find(m => m.orgId === orgId);
  const role = session.isStaff ? 'owner' : membership?.dashboardRole ?? 'read';
  const permissions = [...PERMISSIONS_BY_DASHBOARD_ROLE[role]];
  const updated: AppSession = {
    ...session,
    activeOrgId: orgId,
    role,
    permissions,
    allowedViews: viewsForPermissions(permissions),
  };
  const meResult = MeResponseSchema.safeParse(buildMePayload(updated));
  if (!meResult.success) {
    console.error('[/api/org/switch] MeResponseSchema validation failed:', meResult.error.issues);
    return c.json({ error: ERR_INTERNAL }, Http.InternalServerError);
  }
  return c.json(meResult.data);
});

app.post('/api/logout', (c) => {
  const session = c.get('session');
  logActivity(session.appUserId, 'logout', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.body(null, Http.NoContent);
});

app.post('/api/activity', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = ActivityRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: ERR_INVALID_REQUEST_BODY }, Http.BadRequest);
  logActivity(c.get('session').appUserId, result.data.activity_type, c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.body(null, Http.NoContent);
});

app.get('/api/dashboard', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const role = c.req.query('role');
  if (role && !VALID_ROLES.includes(role as typeof VALID_ROLES[number])) {
    return c.json({ error: ERR_INVALID_ROLE }, Http.BadRequest);
  }
  if (role && !session.allowedViews.includes(role as DashboardView)) {
    return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  }

  const key = role ? `dashboard:${period}:${role}` : `dashboard:${period}`;
  const data = await getSessionKv<unknown>(c,key);
  if (!data) return c.json({ error: ERR_NO_DATA }, Http.NotFound);
  logActivity(session.appUserId, 'dashboard_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json(data);
});

app.get('/api/metrics/:name/evaluations', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, Http.BadRequest);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const pagination = PaginationSchema.safeParse({ limit: c.req.query('limit'), offset: c.req.query('offset') });
  if (!pagination.success) return c.json({ error: ERR_INVALID_PAGINATION }, Http.BadRequest);
  const { limit, offset } = pagination.data;
  const sortBy = c.req.query('sortBy') ?? 'timestamp_desc';
  if (!VALID_SORT_BY.includes(sortBy as typeof VALID_SORT_BY[number])) {
    return c.json({ error: ERR_INVALID_SORT_BY }, Http.BadRequest);
  }
  const scoreLabel = c.req.query('scoreLabel');

  const data = await getSessionKv<{ rows: Record<string, unknown>[] }>(c, `metric:evaluations:${name}:${period}`);
  if (!data) return c.json({ rows: [], total: 0, limit, offset, hasMore: false });

  let rows = data.rows;
  if (scoreLabel) rows = rows.filter((r: Record<string, unknown>) => r.label === scoreLabel);
  if (sortBy === 'score_asc') rows.sort((a, b) => (typeof a.score === 'number' ? a.score : 0) - (typeof b.score === 'number' ? b.score : 0));
  else if (sortBy === 'score_desc') rows.sort((a, b) => (typeof b.score === 'number' ? b.score : 0) - (typeof a.score === 'number' ? a.score : 0));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return c.json({ rows: page, total, limit, offset, hasMore: offset + limit < total });
});

app.get('/api/metrics/:name', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, Http.BadRequest);
  const data = await getSessionKv<unknown>(c,`metric:${name}`);
  if (!data) {
    return c.json({
      name,
      displayName: name,
      status: 'no_data',
      values: { count: 0 },
      alerts: [],
      sampleCount: 0,
      scoreDistribution: [],
      worstEvaluations: [],
      bestEvaluations: [],
    });
  }
  return c.json(data);
});

app.get('/api/trends/:name', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, Http.BadRequest);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const data = await getSessionKv<unknown>(c,`trend:${name}:${period}`);
  if (!data) return c.json({ metric: name, period, points: [], bucketCount: 0 });
  return c.json(data);
});

app.get('/api/evaluations/trace/:traceId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const traceId = c.req.param('traceId');
  if (!isValidId(traceId)) return c.json({ error: ERR_INVALID_TRACE_ID }, Http.BadRequest);
  const data = await getSessionKv<unknown>(c,`evaluations:trace:${traceId}`);
  if (!data) return c.json({ evaluations: [] });
  logActivity(session.appUserId, 'trace_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json(data);
});

app.get('/api/traces/:traceId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const traceId = c.req.param('traceId');
  if (!isValidId(traceId)) return c.json({ error: ERR_INVALID_TRACE_ID }, Http.BadRequest);
  const data = await getSessionKv<unknown>(c,`trace:${traceId}`);
  if (!data) return c.json({ error: `No trace data for: ${traceId}` }, Http.NotFound);
  logActivity(session.appUserId, 'trace_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json(data);
});

app.get('/api/correlations', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '30d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const data = await getSessionKv<unknown>(c,`correlations:${period}`);
  if (!data) return c.json({ correlations: [], metrics: [] });
  return c.json(data);
});

app.get('/api/degradation-signals', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  // Key matches DEGRADATION_KV_KEY in src/lib/quality/quality-constants.ts + period suffix
  const data = await getSessionKv<unknown>(c,`meta/dashboard/degradation-signals:${period}`);
  if (!data) return c.json({ period, reports: [], computedAt: null });
  return c.json(data);
});

app.get('/api/coverage', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const inputKey = c.req.query('inputKey') ?? 'traceId';
  if (!VALID_INPUT_KEYS.includes(inputKey as typeof VALID_INPUT_KEYS[number])) {
    return c.json({ error: ERR_INVALID_INPUT_KEY }, Http.BadRequest);
  }
  const data = await getSessionKv<unknown>(c,`coverage:${period}:${inputKey}`);
  if (!data) return c.json({ period, metrics: [], inputs: [], heatmap: [] });
  return c.json(data);
});

app.get('/api/pipeline', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.pipeline.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const data = await getSessionKv<unknown>(c,`pipeline:${period}`);
  if (!data) return c.json({ period, stages: [], totalEvaluations: 0 });
  return c.json(data);
});

app.get('/api/sessions/:sessionId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.sessions.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const sessionId = c.req.param('sessionId');
  if (!isValidId(sessionId)) return c.json({ error: ERR_INVALID_SESSION_ID }, Http.BadRequest);
  const data = await getSessionKv<unknown>(c,`session:${sessionId}`);
  if (!data) return c.json({ error: `No session data for: ${sessionId}` }, Http.NotFound);
  logActivity(session.appUserId, 'session_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json(data);
});

app.get('/api/agents', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const data = await getSessionKv<unknown>(c,'meta:agents');
  if (!data) return c.json([]);
  return c.json(data);
});

app.get('/api/agents/detail/:agentId', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const agentId = c.req.param('agentId');
  if (!isValidId(agentId)) return c.json({ error: ERR_INVALID_AGENT_ID }, Http.BadRequest);
  const data = await getSessionKv<unknown>(c,`agent:${agentId}`);
  if (!data) return c.json({ error: `No data for agent: ${agentId}` }, Http.NotFound);
  return c.json(data);
});

app.get('/api/agents/:sessionId', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const sessionId = c.req.param('sessionId');
  if (!isValidId(sessionId)) return c.json({ error: ERR_INVALID_SESSION_ID }, Http.BadRequest);
  const session = await getSessionKv<Record<string, unknown>>(c, `session:${sessionId}`);
  if (!session) return c.json({ error: `No session data for: ${sessionId}` }, Http.NotFound);
  return c.json({
    sessionId,
    spans: [],
    evaluation: session['multiAgentEvaluation'] ?? null,
    evaluations: safeArray(session['evaluations']),
    agentMap: {},
  });
});

app.get('/api/compliance/sla', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const dashboard = await getSessionKv<Record<string, unknown>>(c, `dashboard:${period}`);
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  logActivity(session.appUserId, 'compliance_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  const slaResults = safeArray(dashboard['slaCompliance']);
  return c.json({
    period,
    results: slaResults,
    noSLAsConfigured: slaResults.length === 0,
  });
});

app.get('/api/compliance/verifications', (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  logActivity(session.appUserId, 'compliance_view', c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.json({ period, count: 0, verifications: [] });
});

app.get('/api/calibration', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const raw = await getSessionKv<unknown>(c,'meta:calibration');
  if (!raw) return c.json({ error: ERR_NO_CALIBRATION_DATA }, Http.NotFound);
  // KV can still hold a payload written by an older sync-to-kv; parse rather
  // than pass through, so drift surfaces here instead of in the frontend.
  const result = calibrationResponseSchema.safeParse(raw);
  if (!result.success) {
    console.error('[/api/calibration] schema validation failed:', result.error.issues);
    return c.json({ error: ERR_CALIBRATION_MALFORMED }, Http.InternalServerError);
  }
  return c.json(result.data);
});

app.get('/api/routing-telemetry', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const period = c.req.query('period') ?? '7d';
  if (!VALID_PERIOD_KEYS.includes(period as typeof VALID_PERIOD_KEYS[number])) {
    return c.json({ error: ERR_INVALID_PERIOD }, Http.BadRequest);
  }
  const raw = await getSessionKv<unknown>(c,`routing-telemetry:${period}`);
  const result = routingTelemetryKvSchema.safeParse(raw ?? {});
  if (!result.success) {
    console.error('[/api/routing-telemetry] schema validation failed:', result.error.issues);
    return c.json({ error: ERR_ROUTING_TELEMETRY_MALFORMED }, Http.InternalServerError);
  }
  return c.json({ ...result.data, period });
});

app.get('/api/health', async (c) => {
  // Session-less route (auth-bypassed): under org scoping it must never touch
  // an org-prefixed key, so it reads the allowlisted global heartbeat that
  // sync-to-kv writes alongside the per-org lastSync keys (P4/P5, Risk 8).
  // Flag OFF keeps today's bare meta:lastSync read for regression-cleanliness.
  const lastSync = c.env.ORG_SCOPING_ENABLED === 'true'
    ? await getGlobalKv<string>(c.env.DASHBOARD, 'system:lastSync')
    : await getKv<string>(c.env.DASHBOARD, null, 'meta:lastSync', c.env);
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

// ---------------------------------------------------------------------------
// Org-scoped admin (P6) — every route is bound to session.activeOrgId, never a
// client parameter, so an org admin can only ever mutate their own org.
// Unavailable on legacy (non-org) sessions: those keep the global routes below.
// ---------------------------------------------------------------------------

/** Org-admin gate: dashboard.admin + an org-scoped session. Returns null when refused. */
function orgAdminScope(c: AppContext): { session: AppSession; orgId: string } | null {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.admin')) return null;
  if (!session.activeOrgId) return null;
  return { session, orgId: session.activeOrgId };
}

/** Only owners (or staff) may grant, downgrade, or remove an `owner` membership. */
function canTouchOwnerRole(session: AppSession): boolean {
  return session.isStaff === true || session.role === 'owner';
}

app.get('/api/admin/members', async (c) => {
  const scope = orgAdminScope(c);
  if (!scope) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?select=user_id,role,users(id,email)&organization_id=eq.${encodeURIComponent(scope.orgId)}`,
    { headers: serviceRoleHeaders(c.env) },
  ).catch(() => null);
  if (!res?.ok) return c.json({ error: 'Failed to fetch members' }, Http.InternalServerError);

  const rawJson: unknown = await res.json().catch(() => null);
  const members = [];
  for (const row of safeArray(rawJson)) {
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

app.post('/api/admin/members/:userId/role', async (c) => {
  const scope = orgAdminScope(c);
  if (!scope) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const userId = c.req.param('userId');
  if (!UUID_PATTERN.test(userId)) return c.json({ error: ERR_INVALID_USER_ID }, Http.BadRequest);

  const body: unknown = await c.req.json().catch(() => null);
  const result = UpdateMemberRoleRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: ERR_INVALID_REQUEST_BODY }, Http.BadRequest);
  const newRole = result.data.membershipRole;

  // Read the target's current role first — both granting owner and demoting an
  // existing owner are owner-only operations.
  const currentRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?select=role&organization_id=eq.${encodeURIComponent(scope.orgId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: serviceRoleHeaders(c.env) },
  ).catch(() => null);
  if (!currentRes?.ok) return c.json({ error: 'Failed to fetch member' }, Http.InternalServerError);
  const currentRows = safeArray<{ role?: string }>(await currentRes.json().catch(() => []));
  if (!currentRows[0]) return c.json({ error: ERR_INVALID_USER_ID }, Http.NotFound);
  const currentRole = currentRows[0].role;

  if ((newRole === 'owner' || currentRole === 'owner') && !canTouchOwnerRole(scope.session)) {
    return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  }

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?organization_id=eq.${encodeURIComponent(scope.orgId)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { ...(serviceRoleHeaders(c.env) as Record<string, string>), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ role: newRole }),
    },
  ).catch(() => null);
  if (!res?.ok) return c.json({ error: 'Failed to update member role' }, Http.InternalServerError);
  logAuditEvent(scope.session.appUserId, 'member.role_change', userId, undefined, c.env, c.executionCtx.waitUntil.bind(c.executionCtx), scope.orgId);
  return c.body(null, Http.NoContent);
});

app.delete('/api/admin/members/:userId', async (c) => {
  const scope = orgAdminScope(c);
  if (!scope) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  const userId = c.req.param('userId');
  if (!UUID_PATTERN.test(userId)) return c.json({ error: ERR_INVALID_USER_ID }, Http.BadRequest);

  const currentRes = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?select=role&organization_id=eq.${encodeURIComponent(scope.orgId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
    { headers: serviceRoleHeaders(c.env) },
  ).catch(() => null);
  if (!currentRes?.ok) return c.json({ error: 'Failed to fetch member' }, Http.InternalServerError);
  const currentRows = safeArray<{ role?: string }>(await currentRes.json().catch(() => []));
  if (!currentRows[0]) return c.json({ error: ERR_INVALID_USER_ID }, Http.NotFound);
  if (currentRows[0].role === 'owner' && !canTouchOwnerRole(scope.session)) {
    return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);
  }

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/organization_memberships?organization_id=eq.${encodeURIComponent(scope.orgId)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'DELETE', headers: serviceRoleHeaders(c.env) },
  ).catch(() => null);
  if (!res?.ok) return c.json({ error: 'Failed to remove member' }, Http.InternalServerError);
  logAuditEvent(scope.session.appUserId, 'member.remove', userId, undefined, c.env, c.executionCtx.waitUntil.bind(c.executionCtx), scope.orgId);
  return c.body(null, Http.NoContent);
});

// Legacy GLOBAL admin routes: under org scoping these become staff-only —
// dashboard.admin is now an org-scoped grant and must not reach cross-org
// user_roles mutation. Flag OFF keeps today's dashboard.admin gate.
function canUseGlobalAdmin(c: AppContext): boolean {
  const session = c.get('session');
  if (c.env.ORG_SCOPING_ENABLED === 'true') return session.isStaff === true;
  return hasPermission(session, 'dashboard.admin');
}

// Admin error handling policy:
// All admin routes (/api/admin/*) return generic error messages on Supabase REST failures,
// e.g. "Failed to fetch users" instead of the raw Supabase error body. This is intentional:
// - The service role key is used, so Supabase error bodies may contain table/column metadata.
// - Generic messages prevent internal schema details from leaking to admin clients.
// - HTTP status is always 500 on upstream failure; 400 for input validation.
// - Supabase errors are swallowed; failures are surfaced only via status code + generic message.
// This policy aligns with sanitizeErrorForResponse used in API routes.

app.get('/api/admin/users', async (c) => {
  if (!canUseGlobalAdmin(c)) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);

  const headers = serviceRoleHeaders(c.env);
  const [usersRes, roleRowsRes] = await Promise.all([
    fetch(`${c.env.SUPABASE_URL}/rest/v1/users?select=id,email,created_at&order=created_at.desc`, { headers }),
    fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles?select=user_id,role_id,roles(id,name)`, { headers }),
  ]);

  if (!usersRes.ok) return c.json({ error: 'Failed to fetch users' }, Http.InternalServerError);
  if (!roleRowsRes.ok) return c.json({ error: 'Failed to fetch role assignments' }, Http.InternalServerError);
  const rawUsersJson: unknown = await usersRes.json().catch(() => null);
  const rawUsers = safeArray(rawUsersJson);
  const rawRoleRowsJson: unknown = await roleRowsRes.json().catch(() => []);
  const rawRoleRows = safeArray(rawRoleRowsJson);

  const rolesByUser = new Map<string, { id: string; name: string }[]>();
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
      id: r['id'],
      email: r['email'],
      created_at: r['created_at'],
      roles: rolesByUser.get(r['id'] as string) ?? [],
    });
    if (parsed.success) users.push(parsed.data);
  }

  return c.json(users);
});

app.get('/api/admin/roles', async (c) => {
  if (!canUseGlobalAdmin(c)) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/roles?select=id,name,permissions&order=name.asc`,
    { headers: serviceRoleHeaders(c.env) },
  );
  if (!res.ok) return c.json({ error: 'Failed to fetch roles' }, Http.InternalServerError);

  const rawJson: unknown = await res.json().catch(() => null);
  const rows = safeArray(rawJson);
  const roles = rows.flatMap((row) => {
    const parsed = AdminRoleSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return c.json(roles);
});

app.post('/api/admin/users/:userId/roles', async (c) => {
  if (!canUseGlobalAdmin(c)) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);

  const userId = c.req.param('userId');
  if (!UUID_PATTERN.test(userId)) return c.json({ error: ERR_INVALID_USER_ID }, Http.BadRequest);

  const body: unknown = await c.req.json().catch(() => null);
  const result = AssignRoleRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: ERR_INVALID_REQUEST_BODY }, Http.BadRequest);

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { ...(serviceRoleHeaders(c.env) as Record<string, string>), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, role_id: result.data.role_id }),
  });
  if (!res.ok) return c.json({ error: 'Failed to assign role' }, Http.InternalServerError);
  logAuditEvent(c.get('session').appUserId, 'role.assign', userId, result.data.role_id, c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.body(null, Http.NoContent);
});

app.delete('/api/admin/users/:userId/roles/:roleId', async (c) => {
  if (!canUseGlobalAdmin(c)) return c.json({ error: ERR_FORBIDDEN }, Http.Forbidden);

  const userId = c.req.param('userId');
  const roleId = c.req.param('roleId');
  if (!UUID_PATTERN.test(userId)) return c.json({ error: ERR_INVALID_USER_ID }, Http.BadRequest);
  if (!UUID_PATTERN.test(roleId)) return c.json({ error: ERR_INVALID_ROLE_ID }, Http.BadRequest);

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&role_id=eq.${encodeURIComponent(roleId)}`,
    { method: 'DELETE', headers: serviceRoleHeaders(c.env) },
  );
  if (!res.ok) return c.json({ error: 'Failed to revoke role' }, Http.InternalServerError);
  logAuditEvent(c.get('session').appUserId, 'role.revoke', userId, roleId, c.env, c.executionCtx.waitUntil.bind(c.executionCtx));
  return c.body(null, Http.NoContent);
});

// SPA fallback: serve static assets / index.html for non-API routes
app.get('*', async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
