import type { Next } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { z } from 'zod';
import type { PostgrestClient } from '@supabase/postgrest-js';
import type { DashboardPermission, AppSession, DashboardView, OrgMembershipSummary } from '../src/types/auth.js';
import { PublicUserSchema, UserRoleRowSchema, MeResponseSchema, ActivityRequestSchema, OrgMembershipRowSchema, OrgSwitchRequestSchema, DashboardPermissionSchema } from '../src/lib/validation/auth-schemas.js';
import { DASHBOARD_ROLE_BY_MEMBERSHIP, PERMISSION, PERMISSIONS_BY_DASHBOARD_ROLE, viewsForPermissions } from '../src/lib/org-rbac.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, ORG_ID_HEADER, UUID_PATTERN, WORKER_ERR_NO_DATA, WORKER_ERR_NO_CALIBRATION_DATA } from '../src/lib/worker-contract.js';
import { routingTelemetryKvSchema, calibrationResponseSchema } from '../src/lib/validation/dashboard-schemas.js';
import { CONTENT_TYPE_HEADER, HttpStatus } from '../src/lib/http-constants.js';
import { queryValidator } from '../src/lib/query-validator.js';
import { DEFAULT_PERIOD, DEFAULT_PERIOD_DETAIL, INVALID_PERIOD_MESSAGE, PeriodEnum, type Period } from '../src/lib/periods.js';
import { ROLES, RoleSchema } from '../src/lib/roles.js';
import { factory, isOrgScopingEnabled, readJsonBody, requirePermission, safeArray, type AppContext, type Bindings } from './app-context.js';
import { BEARER_PREFIX, db, logActivity } from './supabase.js';
import { registerAdminRoutes } from './admin-routes.js';
import {
  ERR_AUTH_UNAVAILABLE,
  ERR_CALIBRATION_MALFORMED,
  ERR_FAILED_LOAD_USER_ROLES,
  ERR_FORBIDDEN,
  ERR_INTERNAL,
  ERR_INVALID_AGENT_ID,
  ERR_INVALID_METRIC_NAME,
  ERR_INVALID_PAGINATION,
  ERR_INVALID_QUERY,
  ERR_INVALID_REQUEST_BODY,
  ERR_INVALID_ROLE,
  ERR_INVALID_SESSION_ID,
  ERR_INVALID_TRACE_ID,
  ERR_NO_ORG,
  ERR_ROUTING_TELEMETRY_MALFORMED,
  ERR_UNAUTHORIZED,
  NO_RESPONSE_STATUS,
  orList,
} from './error-messages.js';

/**
 * Module-level JWKS cache keyed by AUTH0_DOMAIN.
 *
 * `createRemoteJWKSet` maintains its key cache on the returned object, so
 * creating a new instance per request discards the cache on every call and
 * causes a JWKS fetch round-trip for every authenticated endpoint. Hoisted
 * here (keyed by domain to support multi-tenant deployments), the same object
 * is reused for the isolate lifetime and jose's key cache is preserved.
 * (Audit finding: dashboard Worker fetches Auth0's JWKS on every request.)
 */
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * `iss` values a browser token may carry: the tenant's, plus the custom domain's when one is
 * configured. Auth0 stamps whichever hostname the token was obtained through, with a trailing
 * slash, and signs both with the tenant key set (landing CR70).
 */
export function acceptedIssuers(env: Pick<Bindings, 'AUTH0_DOMAIN' | 'AUTH0_CUSTOM_DOMAIN'>): string[] {
  const issuers = [`https://${env.AUTH0_DOMAIN}/`];
  if (env.AUTH0_CUSTOM_DOMAIN) issuers.push(`https://${env.AUTH0_CUSTOM_DOMAIN}/`);
  return issuers;
}
function getJwks(domain: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksSets.get(domain);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
    jwksSets.set(domain, jwks);
  }
  return jwks;
}

/**
 * True when `jwtVerify` rejected the token itself — bad claims, signature, shape or `kid` — as
 * opposed to failing to reach Auth0. JWKSNoMatchingKey is a rejection: jose raises it after
 * refetching the key set, so the token's kid is not Auth0's (another tenant, or forged).
 * Everything else is upstream: JWKSTimeout, JWKSInvalid, the generic JOSEError jose throws on a
 * non-200 JWKS response, and the raw fetch error it rethrows on a network failure.
 */
function isTokenRejection(err: unknown): boolean {
  return [
    joseErrors.JWTClaimValidationFailed,
    // Not a JWTClaimValidationFailed subclass: both extend JOSEError directly.
    joseErrors.JWTExpired,
    joseErrors.JWSSignatureVerificationFailed,
    joseErrors.JWSInvalid,
    joseErrors.JWTInvalid,
    joseErrors.JWKSNoMatchingKey,
    joseErrors.JWKSMultipleMatchingKeys,
    joseErrors.JOSEAlgNotAllowed,
    joseErrors.JOSENotSupported,
  ].some((cls) => err instanceof cls);
}
const VALID_SORT_BY = ['timestamp_desc', 'score_asc', 'score_desc'] as const;
const ERR_INVALID_SORT_BY = `Invalid sortBy. Must be ${orList(VALID_SORT_BY)}.`;

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});
const VALID_INPUT_KEYS = ['traceId', 'sessionId'] as const;
const ERR_INVALID_INPUT_KEY = `Invalid inputKey. Must be ${orList(VALID_INPUT_KEYS)}.`;

const CORRELATIONS_DEFAULT_PERIOD: Period = '30d';
const periodField = (fallback: Period) => PeriodEnum.default(fallback);
const PeriodQuery = z.object({ period: periodField(DEFAULT_PERIOD) });
const DashboardQuery = z.object({
  period: periodField(DEFAULT_PERIOD),
  // An empty ?role= means "no role", as it did before validation moved here.
  role: RoleSchema.or(z.literal('')).optional(),
});
const MetricEvaluationsQuery = z.object({
  period: periodField(DEFAULT_PERIOD),
  ...PaginationSchema.shape,
  sortBy: z.enum(VALID_SORT_BY).default('timestamp_desc'),
  scoreLabel: z.string().optional(),
});
const CoverageQuery = z.object({
  period: periodField(DEFAULT_PERIOD),
  inputKey: z.enum(VALID_INPUT_KEYS).default('traceId'),
});

/** The error each query field answers with; a schema reports issues in shape order. */
const QUERY_FIELD_ERRORS: Record<string, string> = {
  period: INVALID_PERIOD_MESSAGE,
  role: ERR_INVALID_ROLE,
  limit: ERR_INVALID_PAGINATION,
  offset: ERR_INVALID_PAGINATION,
  sortBy: ERR_INVALID_SORT_BY,
  inputKey: ERR_INVALID_INPUT_KEY,
};

const KV_SCHEMA_VERSION = 1;

const PARAM_RE = /^[\w:.-]+$/;
const MAX_PARAM_LEN = 200;
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
    if (raw.v !== KV_SCHEMA_VERSION) {
      console.warn(`[kv] schema version mismatch for "${key}": expected ${KV_SCHEMA_VERSION}, got ${String(raw.v)} — treating as missing`);
      return null;
    }
    return raw.data as T;
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

const app = factory.createApp();

// A handler that throws (an upstream fetch rejecting, say) gets the same JSON
// error shape as every handled failure, not Hono's plain-text default.
app.onError((err, c) => {
  // An HTTPException carries the response it means; only a genuine fault is a 500.
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[worker] unhandled error on ${c.req.method} ${c.req.path}:`, err instanceof Error ? err.message : String(err));
  return c.json({ error: ERR_INTERNAL }, HttpStatus.InternalServerError);
});

app.use('/*', cors({
  origin: [
    'https://integritystudio.dev',
    'https://www.aledlie.com',
    'https://aledlie.com',
  ],
  // GET, POST, and DELETE are allowed. Bearer JWT auth on all /api/* routes prevents CSRF —
  // browsers cannot set custom Authorization headers in cross-site requests.
  allowMethods: ['GET', 'POST', 'DELETE'],
  // X-Org-Id carries the client's chosen active org (P5/P6); membership-validated
  // server-side in the auth middleware, never trusted as-is.
  allowHeaders: ['Authorization', CONTENT_TYPE_HEADER, ORG_ID_HEADER],
}));

// Cache policy: private, no-store for all /api/* (responses may contain user-specific data)
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

// Session-less, so registered before the auth middleware: a handler that answers ends the chain.
app.get('/api/health', async (c) => {
  // Under org scoping it must never touch an org-prefixed key, so it reads the allowlisted
  // global heartbeat that sync-to-kv writes alongside the per-org lastSync keys (P4/P5, Risk 8).
  // Flag OFF keeps today's bare meta:lastSync read for regression-cleanliness.
  const lastSync = isOrgScopingEnabled(c.env)
    ? await getGlobalKv<string>(c.env.DASHBOARD, 'system:lastSync')
    : await getKv<string>(c.env.DASHBOARD, null, 'meta:lastSync', c.env);
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

const AUTH_TIMEOUT_MS = 5000;

/** The bearer token on the request, or null when there is none to verify. */
function bearerToken(c: AppContext): string | null {
  const authHeader = c.req.header('Authorization');
  return authHeader?.startsWith(BEARER_PREFIX) ? authHeader.slice(BEARER_PREFIX.length) : null;
}

/** The org the bypass session acts in; paired with the fixed app user below. */
const BYPASS_ORG_ID = 'a0000000-0000-4000-8000-000000000001';

/**
 * Test mode: bypass auth when ALLOW_TEST_BYPASS is explicitly enabled in the environment.
 * Never set ALLOW_TEST_BYPASS in production — leave the binding absent.
 *
 * Returns `true` once the bypass session is installed, `false` when this is not a
 * bypass request at all, and a Response when the bypass is refused.
 */
function applyTestBypass(c: AppContext, jwt: string | null): Response | boolean {
  if (c.env.ALLOW_TEST_BYPASS !== 'true' || jwt !== 'test-token') return false;
  // Phase-gate assertion (P5, Q7): refuse the bypass outright when a
  // production env marker is present. HOME_ORG_ID and STAFF_USER_IDS carry
  // real values only on the two production workers (dev deliberately holds
  // '' / '[]'), so either being set means this binding leaked into prod.
  if ((c.env.HOME_ORG_ID ?? '') !== '' || parseStaffIds(c.env.STAFF_USER_IDS).size > 0) {
    console.error('[auth] ALLOW_TEST_BYPASS refused: production env markers present (HOME_ORG_ID/STAFF_USER_IDS)');
    return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
  }
  c.set('session', {
    authUserId: 'auth0|test-user',
    appUserId: 'a0000000-0000-4000-8000-000000000002',
    email: 'test@example.com',
    roles: ['test'],
    permissions: [PERMISSION.admin],
    allowedViews: [...ROLES],
    // Org context (P5): the bypass session carries the org-scoped shape so
    // e2e fixtures and the session contract change in the same phase.
    activeOrgId: BYPASS_ORG_ID,
    memberships: [{
      orgId: BYPASS_ORG_ID,
      slug: 'test-org',
      name: 'Test Org',
      membershipRole: 'owner',
      dashboardRole: 'owner',
    }],
    role: 'owner',
    isStaff: false,
  });
  return true;
}

/** The verified token's `sub`, or the response that refuses the request. */
async function verifiedAuth0Id(c: AppContext, jwt: string): Promise<Response | string> {
  const JWKS = getJwks(c.env.AUTH0_DOMAIN);
  let jwtPayload: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(jwt, JWKS, {
      issuer: acceptedIssuers(c.env),
      audience: c.env.AUTH0_AUDIENCE,
    });
    jwtPayload = payload;
  } catch (err) {
    // A rejected token is 401. Anything else is a transient upstream problem —
    // 503, which the client retries (it never retries a 401).
    if (isTokenRejection(err)) return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
    console.error('[auth] JWKS fetch failed:', err instanceof Error ? err.message : String(err));
    return c.json({ error: ERR_AUTH_UNAVAILABLE }, HttpStatus.ServiceUnavailable);
  }
  const auth0Id = typeof jwtPayload.sub === 'string' ? jwtPayload.sub : null;
  if (!auth0Id) return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
  return auth0Id;
}

type AppUser = { appUserId: string; email: string; defaultOrgId: string | null };

/**
 * The `public.users` row for this auth0 id — required; a user with no app record is
 * rejected. A failed read is upstream (503, retried by the client); only a missing
 * row means the user has no app record (401).
 */
async function loadAppUser(
  c: AppContext,
  supabase: PostgrestClient,
  auth0Id: string,
  signal: AbortSignal,
): Promise<Response | AppUser> {
  const userRes = await supabase.from('users')
    .select('id,email,default_organization_id')
    .eq('auth0_id', auth0Id)
    .limit(1)
    .abortSignal(signal);
  if (userRes.error) {
    console.error('[auth] user lookup failed, status:', userRes.status || NO_RESPONSE_STATUS);
    return c.json({ error: ERR_AUTH_UNAVAILABLE }, HttpStatus.ServiceUnavailable);
  }
  const [rawUser] = safeArray(userRes.data);
  if (!rawUser) return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
  const userResult = PublicUserSchema.safeParse(rawUser);
  if (!userResult.success) return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
  return {
    appUserId: userResult.data.id,
    email: userResult.data.email,
    defaultOrgId: userResult.data.default_organization_id ?? null,
  };
}

/**
 * Roles and (under org scoping) memberships fetch in PARALLEL — Risk 19:
 * the added membership round-trip must not serialize into the auth budget.
 */
async function fetchGrants(
  supabase: PostgrestClient,
  appUserId: string,
  signal: AbortSignal,
  orgScopingEnabled: boolean,
) {
  const rolesPromise = supabase.from('user_roles')
    .select('roles(name,permissions)')
    .eq('user_id', appUserId)
    .abortSignal(signal);
  const membershipsPromise = orgScopingEnabled
    ? supabase.from('organization_memberships')
      .select('role,organization_id,organizations(id,slug,name)')
      .eq('user_id', appUserId)
      .abortSignal(signal)
    : null;
  return Promise.all([rolesPromise, membershipsPromise]);
}

type MembershipsResult = Awaited<ReturnType<typeof fetchGrants>>[1];

type RoleGrants = { roles: string[]; permissionSet: Set<DashboardPermission> };

/** DB permission strings are untrusted: only known DashboardPermission values reach the session. */
function parseRoleGrants(rows: unknown[]): RoleGrants {
  const roles: string[] = [];
  const permissionSet = new Set<DashboardPermission>();
  for (const row of rows) {
    const rowResult = UserRoleRowSchema.safeParse(row);
    if (!rowResult.success || !rowResult.data.roles) continue;
    roles.push(rowResult.data.roles.name);
    for (const perm of rowResult.data.roles.permissions) {
      const known = DashboardPermissionSchema.safeParse(perm);
      if (known.success) permissionSet.add(known.data);
    }
  }
  return { roles, permissionSet };
}

/**
 * Resolve activeOrgId: X-Org-Id (membership-validated, or staff) →
 * default_organization_id (re-validated — Risk 15) → first membership, and for
 * staff alone, the home org. Undefined when none of them resolves.
 */
function resolveActiveOrg(
  c: AppContext,
  memberships: readonly OrgMembershipSummary[],
  isStaff: boolean,
  defaultOrgId: string | null,
): Response | string | undefined {
  const requestedOrg = c.req.header(ORG_ID_HEADER);
  let activeOrgId: string | undefined;
  if (requestedOrg) {
    if (!UUID_PATTERN.test(requestedOrg)) return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
    if (!canEnterOrg(isStaff, memberships, requestedOrg)) return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
    activeOrgId = requestedOrg;
  }
  if (!activeOrgId && defaultOrgId && canEnterOrg(isStaff, memberships, defaultOrgId)) {
    activeOrgId = defaultOrgId;
  }
  activeOrgId ??= memberships[0]?.orgId;
  if (!activeOrgId && isStaff) activeOrgId = c.env.HOME_ORG_ID;
  return activeOrgId;
}

/** The org-scoped session: permissions come from the active org's membership role. */
async function orgScopedSession(c: AppContext, args: {
  next: Next;
  authUserId: string;
  user: AppUser;
  roles: string[];
  membershipsRes: MembershipsResult;
}) {
  const { next, authUserId, user, roles, membershipsRes } = args;
  // Fail closed: a failed read must not pass for "no memberships", which answers a
  // non-retried 403 (or, for staff, the home org).
  if (membershipsRes?.error) {
    console.error('[auth] membership fetch failed for user', user.appUserId, 'status:', membershipsRes.status || NO_RESPONSE_STATUS);
    return c.json({ error: ERR_AUTH_UNAVAILABLE }, HttpStatus.ServiceUnavailable);
  }
  const memberships = parseMemberships(membershipsRes?.data);
  const isStaff = parseStaffIds(c.env.STAFF_USER_IDS).has(user.appUserId);

  const activeOrgId = resolveActiveOrg(c, memberships, isStaff, user.defaultOrgId);
  if (activeOrgId instanceof Response) return activeOrgId;

  if (activeOrgId) {
    const grant = orgGrant(isStaff, memberships, activeOrgId);
    c.set('session', {
      authUserId, appUserId: user.appUserId, email: user.email, roles,
      ...grant, activeOrgId, memberships, isStaff,
    });
    return next();
  }

  // No active org and not staff: refuse, whatever the user's roles
  // (AUTH-NO-ORG-LEGACY-SESSION). The on_user_created trigger gives every
  // new user a role, so the old roles-only fallback (Risk 13) handed every
  // user without an org a global session reading the home org's bare keys.
  return c.json({ error: ERR_NO_ORG }, HttpStatus.Forbidden);
}

/** The pre-org-scoping session: permissions come from the user's legacy roles. */
function legacySession(c: AppContext, authUserId: string, user: AppUser, grants: RoleGrants): void {
  const permissions = [...grants.permissionSet];
  const allowedViews: DashboardView[] = grants.permissionSet.has(PERMISSION.admin) ? [...ROLES] : viewsForPermissions(permissions);
  c.set('session', {
    authUserId, appUserId: user.appUserId, email: user.email,
    roles: grants.roles, permissions, allowedViews,
  });
}

const authenticate = factory.createMiddleware(async (c, next) => {
  const jwt = bearerToken(c);

  const bypass = applyTestBypass(c, jwt);
  if (bypass instanceof Response) return bypass;
  if (bypass) return next();

  if (!jwt) return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);

  // One deadline shared across all auth fetches
  const signal = AbortSignal.timeout(AUTH_TIMEOUT_MS);

  const auth0Id = await verifiedAuth0Id(c, jwt);
  if (auth0Id instanceof Response) return auth0Id;

  const orgScopingEnabled = isOrgScopingEnabled(c.env);
  if (orgScopingEnabled && !c.env.HOME_ORG_ID) {
    // Fail loudly: an empty HOME_ORG_ID (the dev worker's deliberate value)
    // must never silently resolve or fall back into a production org.
    console.error('[auth] ORG_SCOPING_ENABLED=true but HOME_ORG_ID is empty — refusing to serve');
    return c.json({ error: ERR_INTERNAL }, HttpStatus.InternalServerError);
  }

  const supabase = db(c.env);
  const user = await loadAppUser(c, supabase, auth0Id, signal);
  if (user instanceof Response) return user;

  const [rolesRes, membershipsRes] = await fetchGrants(supabase, user.appUserId, signal, orgScopingEnabled);

  if (rolesRes.error) {
    console.error('[auth] role fetch failed for user', user.appUserId, 'status:', rolesRes.status || NO_RESPONSE_STATUS);
    return c.json({ error: ERR_FAILED_LOAD_USER_ROLES }, HttpStatus.InternalServerError);
  }
  const grants = parseRoleGrants(safeArray(rolesRes.data));

  if (orgScopingEnabled) {
    return orgScopedSession(c, { next, authUserId: auth0Id, user, roles: grants.roles, membershipsRes });
  }

  legacySession(c, auth0Id, user, grants);
  return next();
});

app.use('/api/*', authenticate);

/** Parsed STAFF_USER_IDS by raw value: env is fixed for an isolate, so each value parses once. */
const staffIdSets = new Map<string, ReadonlySet<string>>();
const NO_STAFF: ReadonlySet<string> = new Set();

/** Parse the STAFF_USER_IDS env (JSON array of app user UUIDs) — fail closed on malformed input. */
function parseStaffIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return NO_STAFF;
  let ids = staffIdSets.get(raw);
  if (!ids) {
    ids = parseStaffIdList(raw);
    staffIdSets.set(raw, ids);
  }
  return ids;
}

function parseStaffIdList(raw: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((v): v is string => typeof v === 'string')) : NO_STAFF;
  } catch {
    console.error('[auth] STAFF_USER_IDS is not valid JSON — treating as empty allowlist');
    return NO_STAFF;
  }
}

/** Staff may enter any org; everyone else only the orgs they are a member of. */
function canEnterOrg(isStaff: boolean, memberships: readonly OrgMembershipSummary[], orgId: string): boolean {
  return isStaff || memberships.some(m => m.orgId === orgId);
}

/**
 * The session fields `orgId` grants: staff act as owner, members by their membership's dashboard
 * role. No dashboard.admin → all-views shortcut on the org path: an org admin gets [] views but
 * keeps data-route access via hasPermission (spec).
 */
function orgGrant(
  isStaff: boolean,
  memberships: readonly OrgMembershipSummary[],
  orgId: string,
): Pick<AppSession, 'role' | 'permissions' | 'allowedViews'> {
  const membership = memberships.find(m => m.orgId === orgId);
  const role = isStaff ? 'owner' : membership?.dashboardRole ?? 'read';
  const permissions = [...PERMISSIONS_BY_DASHBOARD_ROLE[role]];
  return { role, permissions, allowedViews: viewsForPermissions(permissions) };
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

function validQuery<T extends z.ZodType>(schema: T) {
  return queryValidator(schema, QUERY_FIELD_ERRORS, ERR_INVALID_QUERY);
}

/**
 * Session-scoped KV read used by every /api/* data route. With
 * ORG_SCOPING_ENABLED=false this is a bare-key read; with it on, the auth
 * middleware refuses any session without an activeOrgId.
 */
async function getSessionKv<T>(c: AppContext, key: string): Promise<T | null> {
  const orgId = isOrgScopingEnabled(c.env)
    ? c.get('session').activeOrgId ?? null
    : null;
  return getKv<T>(c.env.DASHBOARD, orgId, key, c.env);
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

/** The validated me payload for `session`, or a 500 when it does not satisfy MeResponseSchema. */
function respondMe(c: AppContext, session: AppSession): Response {
  const meResult = MeResponseSchema.safeParse(buildMePayload(session));
  if (!meResult.success) {
    console.error(`[${c.req.path}] MeResponseSchema validation failed:`, meResult.error.issues);
    return c.json({ error: ERR_INTERNAL }, HttpStatus.InternalServerError);
  }
  return c.json(meResult.data);
}

app.get('/api/me', (c) => respondMe(c, c.get('session')));

// Switch the active org: membership-validated (or staff), persisted as the
// user's default_organization_id, and echoed back as an updated me payload.
// Under ORG_SCOPING_ENABLED=false sessions carry no memberships, so this
// naturally 403s — the route is inert until cutover.
app.post('/api/org/switch', async (c) => {
  const session = c.get('session');
  const body = await readJsonBody(c.req, OrgSwitchRequestSchema);
  if (!body) return c.json({ error: ERR_INVALID_REQUEST_BODY }, HttpStatus.BadRequest);
  const { orgId } = body;

  const isStaff = session.isStaff === true;
  const memberships = session.memberships ?? [];
  if (!canEnterOrg(isStaff, memberships, orgId)) return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
  if (session.appUserId) {
    const { error } = await db(c.env).from('users')
      .update({ default_organization_id: orgId })
      .eq('id', session.appUserId);
    if (error) return c.json({ error: ERR_INTERNAL }, HttpStatus.InternalServerError);
  }

  // Recompute the org-dependent session fields for the response; the next
  // request re-resolves fully at the middleware.
  return respondMe(c, { ...session, activeOrgId: orgId, ...orgGrant(isStaff, memberships, orgId) });
});

app.post('/api/logout', (c) => {
  logActivity(c, 'logout');
  return c.body(null, HttpStatus.NoContent);
});

app.post('/api/activity', async (c) => {
  const body = await readJsonBody(c.req, ActivityRequestSchema);
  if (!body) return c.json({ error: ERR_INVALID_REQUEST_BODY }, HttpStatus.BadRequest);
  logActivity(c, body.activity_type);
  return c.body(null, HttpStatus.NoContent);
});

app.get('/api/dashboard', requirePermission(PERMISSION.read), validQuery(DashboardQuery), async (c) => {
  const session = c.get('session');
  const { period, role } = c.req.valid('query');
  if (role && !session.allowedViews.includes(role)) {
    return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
  }

  const key = role ? `dashboard:${period}:${role}` : `dashboard:${period}`;
  const data = await getSessionKv<unknown>(c, key);
  if (!data) return c.json({ error: WORKER_ERR_NO_DATA }, HttpStatus.NotFound);
  logActivity(c, 'dashboard_view');
  return c.json(data);
});

/** A row's numeric score for sorting; a row without one sorts as 0. */
function scoreOf(row: Record<string, unknown>): number {
  return typeof row.score === 'number' ? row.score : 0;
}

app.get('/api/metrics/:name/evaluations', requirePermission(PERMISSION.read), validQuery(MetricEvaluationsQuery), async (c) => {
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, HttpStatus.BadRequest);
  const { period, limit, offset, sortBy, scoreLabel } = c.req.valid('query');

  const data = await getSessionKv<{ rows: Array<Record<string, unknown>> }>(c, `metric:evaluations:${name}:${period}`);
  if (!data) return c.json({ rows: [], total: 0, limit, offset, hasMore: false });

  let rows = data.rows;
  if (scoreLabel) rows = rows.filter((r: Record<string, unknown>) => r.label === scoreLabel);
  if (sortBy === 'score_asc') rows.sort((a, b) => scoreOf(a) - scoreOf(b));
  else if (sortBy === 'score_desc') rows.sort((a, b) => scoreOf(b) - scoreOf(a));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return c.json({ rows: page, total, limit, offset, hasMore: offset + limit < total });
});

// Written by scripts/sync-to-kv.ts (METRIC_DETAIL_KEY_PREFIX in src/api/aggregates/metric-detail.ts).
// The Worker cannot import that module, so the prefix is restated here.
const METRIC_DETAIL_KEY_PREFIX = 'metric:';

app.get('/api/metrics/:name', requirePermission(PERMISSION.read), validQuery(z.object({ period: periodField(DEFAULT_PERIOD_DETAIL) })), async (c) => {
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, HttpStatus.BadRequest);
  const { period } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `${METRIC_DETAIL_KEY_PREFIX}${name}:${period}`);
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

// Written by scripts/sync-to-kv.ts (TREND_KEY_PREFIX in src/api/aggregates/trend.ts), restated as above.
const TREND_KEY_PREFIX = 'trend:';

app.get('/api/trends/:name', requirePermission(PERMISSION.read), validQuery(PeriodQuery), async (c) => {
  const name = c.req.param('name');
  if (!isValidId(name)) return c.json({ error: ERR_INVALID_METRIC_NAME }, HttpStatus.BadRequest);
  const { period } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `${TREND_KEY_PREFIX}${name}:${period}`);
  // The empty `TrendView` of src/api/aggregates/trend.ts, restated: the page reads `trendData`.
  if (!data) {
    return c.json({ metric: name, period, bucketCount: 0, totalEvaluations: 0, overallPercentiles: null, trendData: [], narrowed: false });
  }
  return c.json(data);
});

app.get('/api/evaluations/trace/:traceId', requirePermission(PERMISSION.traces), async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidId(traceId)) return c.json({ error: ERR_INVALID_TRACE_ID }, HttpStatus.BadRequest);
  const data = await getSessionKv<unknown>(c, `evaluations:trace:${traceId}`);
  if (!data) return c.json({ evaluations: [] });
  logActivity(c, 'trace_view');
  return c.json(data);
});

app.get('/api/traces/:traceId', requirePermission(PERMISSION.traces), async (c) => {
  const traceId = c.req.param('traceId');
  if (!isValidId(traceId)) return c.json({ error: ERR_INVALID_TRACE_ID }, HttpStatus.BadRequest);
  const data = await getSessionKv<unknown>(c, `trace:${traceId}`);
  if (!data) return c.json({ error: `No trace data for: ${traceId}` }, HttpStatus.NotFound);
  logActivity(c, 'trace_view');
  return c.json(data);
});

app.get('/api/correlations', requirePermission(PERMISSION.read), validQuery(z.object({ period: periodField(CORRELATIONS_DEFAULT_PERIOD) })), async (c) => {
  const { period } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `correlations:${period}`);
  if (!data) return c.json({ correlations: [], metrics: [] });
  return c.json(data);
});

app.get('/api/degradation-signals', requirePermission(PERMISSION.read), validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  // Key matches DEGRADATION_KV_KEY in src/lib/quality/quality-constants.ts + period suffix
  const data = await getSessionKv<unknown>(c, `meta/dashboard/degradation-signals:${period}`);
  if (!data) return c.json({ period, reports: [], computedAt: null });
  return c.json(data);
});

app.get('/api/coverage', requirePermission(PERMISSION.read), validQuery(CoverageQuery), async (c) => {
  const { period, inputKey } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `coverage:${period}:${inputKey}`);
  // Shape-compatible empty matrix: the grid derives status and gaps from
  // `counts`, so an absent key must still present every field it reads.
  if (!data) return c.json({ period, metrics: [], inputs: [], counts: [], coveredThreshold: 1, partialThreshold: 0, overallCoveragePercent: 0 });
  return c.json(data);
});

app.get('/api/pipeline', requirePermission(PERMISSION.pipeline), validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `pipeline:${period}`);
  if (!data) return c.json({ period, stages: [], totalEvaluations: 0 });
  return c.json(data);
});

app.get('/api/sessions/:sessionId', requirePermission(PERMISSION.sessions), async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidId(sessionId)) return c.json({ error: ERR_INVALID_SESSION_ID }, HttpStatus.BadRequest);
  const data = await getSessionKv<unknown>(c, `session:${sessionId}`);
  if (!data) return c.json({ error: `No session data for: ${sessionId}` }, HttpStatus.NotFound);
  logActivity(c, 'session_view');
  return c.json(data);
});

// Written by scripts/sync-to-kv.ts (AGENT_STATS_KEY_PREFIX in src/api/aggregates/agent-stats.ts).
// The Worker cannot import that module, so the prefix is restated here.
const AGENT_STATS_KEY_PREFIX = 'meta:agents:';
const AGENTS_DEFAULT_PERIOD: Period = '30d';

app.get('/api/agents', requirePermission(PERMISSION.agents), validQuery(z.object({ period: periodField(AGENTS_DEFAULT_PERIOD) })), async (c) => {
  const { period } = c.req.valid('query');
  const data = await getSessionKv<unknown>(c, `${AGENT_STATS_KEY_PREFIX}${period}`);
  // The page requires `period` and `agents`; the dates are absent until a sync writes the key.
  if (!data) return c.json({ period, startDate: null, endDate: null, agents: [] });
  return c.json(data);
});

// Written by scripts/sync-to-kv.ts (CODE_QUALITY_KV_KEY in src/api/code-quality-summary.ts).
// The Worker cannot import that module, so the key is restated here.
const CODE_QUALITY_KV_KEY = 'code-quality';

app.get('/api/code-quality', requirePermission(PERMISSION.agents), async (c) => {
  const data = await getSessionKv<unknown>(c, CODE_QUALITY_KV_KEY);
  if (!data) return c.json({ survivalByAgentWindow: [], versionRollout: [], hasData: false });
  return c.json(data);
});

app.get('/api/agents/detail/:agentId', requirePermission(PERMISSION.agents), async (c) => {
  const agentId = c.req.param('agentId');
  if (!isValidId(agentId)) return c.json({ error: ERR_INVALID_AGENT_ID }, HttpStatus.BadRequest);
  const data = await getSessionKv<unknown>(c, `agent:${agentId}`);
  if (!data) return c.json({ error: `No data for agent: ${agentId}` }, HttpStatus.NotFound);
  return c.json(data);
});

app.get('/api/agents/:sessionId', requirePermission(PERMISSION.agents), async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidId(sessionId)) return c.json({ error: ERR_INVALID_SESSION_ID }, HttpStatus.BadRequest);
  const session = await getSessionKv<Record<string, unknown>>(c, `session:${sessionId}`);
  if (!session) return c.json({ error: `No session data for: ${sessionId}` }, HttpStatus.NotFound);
  return c.json({
    sessionId,
    spans: [],
    evaluation: session.multiAgentEvaluation ?? null,
    evaluations: safeArray(session.evaluations),
    agentMap: {},
    // Precomputed by sync-to-kv; absent on session keys written before it was added.
    graph: session.workflowGraph ?? null,
  });
});

// The workflow view's payload: the same session key, without its evaluations.
app.get('/api/agents/:sessionId/graph', requirePermission(PERMISSION.agents), async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidId(sessionId)) return c.json({ error: ERR_INVALID_SESSION_ID }, HttpStatus.BadRequest);
  const session = await getSessionKv<Record<string, unknown>>(c, `session:${sessionId}`);
  if (!session) return c.json({ error: `No session data for: ${sessionId}` }, HttpStatus.NotFound);
  return c.json({
    sessionId,
    evaluation: session.multiAgentEvaluation ?? null,
    graph: session.workflowGraph ?? null,
  });
});

app.get('/api/compliance/sla', requirePermission(PERMISSION.compliance), validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const dashboard = await getSessionKv<Record<string, unknown>>(c, `dashboard:${period}`);
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  logActivity(c, 'compliance_view');
  const slaResults = safeArray(dashboard.slaCompliance);
  return c.json({
    period,
    results: slaResults,
    noSLAsConfigured: slaResults.length === 0,
  });
});

app.get('/api/compliance/verifications', requirePermission(PERMISSION.compliance), validQuery(PeriodQuery), (c) => {
  const { period } = c.req.valid('query');
  logActivity(c, 'compliance_view');
  return c.json({ period, count: 0, verifications: [] });
});

app.get('/api/calibration', requirePermission(PERMISSION.read), async (c) => {
  const raw = await getSessionKv<unknown>(c, 'meta:calibration');
  if (!raw) return c.json({ error: WORKER_ERR_NO_CALIBRATION_DATA }, HttpStatus.NotFound);
  // KV can still hold a payload written by an older sync-to-kv; parse rather
  // than pass through, so drift surfaces here instead of in the frontend.
  const result = calibrationResponseSchema.safeParse(raw);
  if (!result.success) {
    console.error('[/api/calibration] schema validation failed:', result.error.issues);
    return c.json({ error: ERR_CALIBRATION_MALFORMED }, HttpStatus.InternalServerError);
  }
  return c.json(result.data);
});

app.get('/api/routing-telemetry', requirePermission(PERMISSION.read), validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const raw = await getSessionKv<unknown>(c, `routing-telemetry:${period}`);
  const result = routingTelemetryKvSchema.safeParse(raw ?? {});
  if (!result.success) {
    console.error('[/api/routing-telemetry] schema validation failed:', result.error.issues);
    return c.json({ error: ERR_ROUTING_TELEMETRY_MALFORMED }, HttpStatus.InternalServerError);
  }
  return c.json({ ...result.data, period });
});

registerAdminRoutes(app);

// SPA fallback: serve static assets / index.html for non-API routes
app.get('*', async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
