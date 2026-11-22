/**
 * The /api/* auth middleware: verifies the Auth0 bearer token, loads the app user and their
 * memberships, and installs the org-scoped session every route reads.
 */

import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import type { PostgrestClient } from '@supabase/postgrest-js';
import type { OrgMembershipSummary } from '../src/types/auth.js';
import { OrgMembershipRowSchema, PublicUserSchema, UserRoleRowSchema } from '../src/lib/validation/auth-schemas.js';
import { DASHBOARD_ROLE_BY_MEMBERSHIP, PERMISSION, PERMISSIONS_BY_DASHBOARD_ROLE, viewsForPermissions } from '../src/lib/org-rbac.js';
import { ORG_ID_HEADER, UUID_PATTERN } from '../src/lib/worker-contract.js';
import { HttpStatus } from '../src/lib/http-constants.js';
import { ROLES } from '../src/lib/roles.js';
import {
  abort,
  authUnavailable,
  factory,
  forbidden,
  internalError,
  parseRows,
  safeArray,
  unauthorized,
  type AppContext,
  type Bindings,
  type WorkerSession,
} from './app-context.js';
import { BEARER_PREFIX, db } from './supabase.js';
import { ERR_FAILED_LOAD_USER_ROLES, ERR_NO_ORG, NO_RESPONSE_STATUS } from './error-messages.js';

/**
 * One key set per AUTH0_DOMAIN for the isolate's lifetime: jose keeps its key cache on the
 * object `createRemoteJWKSet` returns, so a set built per request refetches the JWKS every time.
 */
const jwksSets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * `iss` values a browser token may carry: the tenant's, plus the custom domain's when one is
 * configured. Auth0 stamps whichever hostname the token was obtained through, with a trailing
 * slash, and signs both with the tenant key set.
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
export function canEnterOrg(isStaff: boolean, memberships: readonly OrgMembershipSummary[], orgId: string): boolean {
  return isStaff || memberships.some(m => m.orgId === orgId);
}

/**
 * The session fields `orgId` grants: staff act as owner, members by their membership's dashboard
 * role. No dashboard.admin → all-views shortcut on the org path: an org admin gets [] views but
 * keeps data-route access via hasPermission.
 */
export function orgGrant(
  isStaff: boolean,
  memberships: readonly OrgMembershipSummary[],
  orgId: string,
): Pick<WorkerSession, 'role' | 'permissions' | 'allowedViews'> {
  const membership = memberships.find(m => m.orgId === orgId);
  const role = isStaff ? 'owner' : membership?.dashboardRole ?? 'read';
  const permissions = [...PERMISSIONS_BY_DASHBOARD_ROLE[role]];
  return { role, permissions, allowedViews: viewsForPermissions(permissions) };
}

function parseMemberships(raw: unknown): OrgMembershipSummary[] {
  return parseRows(OrgMembershipRowSchema, raw).flatMap(({ role, organizations }) => organizations ? [{
    orgId: organizations.id,
    slug: organizations.slug,
    name: organizations.name,
    membershipRole: role,
    dashboardRole: DASHBOARD_ROLE_BY_MEMBERSHIP[role],
  }] : []);
}

const AUTH_TIMEOUT_MS = 5000;

/** The bearer token on the request, or null when there is none to verify. */
export function bearerToken(c: AppContext): string | null {
  const authHeader = c.req.header('Authorization');
  return authHeader?.startsWith(BEARER_PREFIX) ? authHeader.slice(BEARER_PREFIX.length) : null;
}

/** The org the bypass session acts in; paired with the fixed app user below. */
const BYPASS_ORG_ID = 'a0000000-0000-4000-8000-000000000001';

/**
 * Installs the test session when ALLOW_TEST_BYPASS is on and the request carries the test
 * token; false when this is not a bypass request. Never set ALLOW_TEST_BYPASS in production.
 */
function applyTestBypass(c: AppContext, jwt: string | null): boolean {
  if (c.env.ALLOW_TEST_BYPASS !== 'true' || jwt !== 'test-token') return false;
  // HOME_ORG_ID and STAFF_USER_IDS carry real values only on the production workers, so
  // either being set means this binding leaked into production.
  if ((c.env.HOME_ORG_ID ?? '') !== '' || parseStaffIds(c.env.STAFF_USER_IDS).size > 0) {
    console.error('[auth] ALLOW_TEST_BYPASS refused: production env markers present (HOME_ORG_ID/STAFF_USER_IDS)');
    abort(unauthorized(c));
  }
  c.set('session', {
    authUserId: 'auth0|test-user',
    appUserId: 'a0000000-0000-4000-8000-000000000002',
    email: 'test@example.com',
    roles: ['test'],
    permissions: [PERMISSION.admin],
    allowedViews: [...ROLES],
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

/** The verified token's `sub`. A rejected token is 401; failing to reach Auth0 is 503. */
async function verifiedAuth0Id(c: AppContext, jwt: string): Promise<string> {
  let jwtPayload: Record<string, unknown>;
  try {
    const { payload } = await jwtVerify(jwt, getJwks(c.env.AUTH0_DOMAIN), {
      issuer: acceptedIssuers(c.env),
      audience: c.env.AUTH0_AUDIENCE,
    });
    jwtPayload = payload;
  } catch (err) {
    if (isTokenRejection(err)) abort(unauthorized(c));
    console.error('[auth] JWKS fetch failed:', err instanceof Error ? err.message : String(err));
    abort(authUnavailable(c));
  }
  return typeof jwtPayload.sub === 'string' && jwtPayload.sub ? jwtPayload.sub : abort(unauthorized(c));
}

function noOrg(c: AppContext): Response {
  return c.json({ error: ERR_NO_ORG }, HttpStatus.Forbidden);
}

function logFailedRead(what: string, res: { status: number }): void {
  console.error(`[auth] ${what} failed, status:`, res.status || NO_RESPONSE_STATUS);
}

type AppUser = { authUserId: string; appUserId: string; email: string; defaultOrgId: string | null };

/**
 * The `public.users` row for this auth0 id. A failed read is upstream (503); only a missing
 * or malformed row means the user has no app record (401).
 */
async function loadAppUser(
  c: AppContext,
  supabase: PostgrestClient,
  auth0Id: string,
  signal: AbortSignal,
): Promise<AppUser> {
  const userRes = await supabase.from('users')
    .select('id,email,default_organization_id')
    .eq('auth0_id', auth0Id)
    .limit(1)
    .abortSignal(signal);
  if (userRes.error) {
    logFailedRead('user lookup', userRes);
    abort(authUnavailable(c));
  }
  const userResult = PublicUserSchema.safeParse(safeArray(userRes.data)[0]);
  if (!userResult.success) abort(unauthorized(c));
  return {
    authUserId: auth0Id,
    appUserId: userResult.data.id,
    email: userResult.data.email,
    defaultOrgId: userResult.data.default_organization_id ?? null,
  };
}

/** Roles and memberships fetch in parallel, inside one auth deadline. */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- a tuple of two postgrest-js responses; restating it would duplicate the builder internals
async function fetchGrants(supabase: PostgrestClient, appUserId: string, signal: AbortSignal) {
  return Promise.all([
    supabase.from('user_roles')
      .select('roles(name,permissions)')
      .eq('user_id', appUserId)
      .abortSignal(signal),
    supabase.from('organization_memberships')
      .select('role,organization_id,organizations(id,slug,name)')
      .eq('user_id', appUserId)
      .abortSignal(signal),
  ]);
}

/** The session lists a user's role names; permissions come from the active org's membership alone. */
function parseRoleNames(rows: unknown): string[] {
  return parseRows(UserRoleRowSchema, rows).flatMap(({ roles }) => roles ? [roles.name] : []);
}

/**
 * Resolve activeOrgId: X-Org-Id (membership-validated, or staff) → default_organization_id
 * (re-validated: the membership may be gone) → first membership, and for staff alone, the
 * home org. Undefined when none of them resolves.
 */
function resolveActiveOrg(
  c: AppContext,
  memberships: readonly OrgMembershipSummary[],
  isStaff: boolean,
  defaultOrgId: string | null,
): string | undefined {
  const requestedOrg = c.req.header(ORG_ID_HEADER);
  if (requestedOrg) {
    if (!UUID_PATTERN.test(requestedOrg) || !canEnterOrg(isStaff, memberships, requestedOrg)) abort(forbidden(c));
    return requestedOrg;
  }
  if (defaultOrgId && canEnterOrg(isStaff, memberships, defaultOrgId)) return defaultOrgId;
  return memberships[0]?.orgId ?? (isStaff ? c.env.HOME_ORG_ID : undefined);
}

/** Installs the org-scoped session: permissions come from the active org's membership role. */
function orgScopedSession(
  c: AppContext,
  user: AppUser,
  roles: string[],
  memberships: OrgMembershipSummary[],
): void {
  const isStaff = parseStaffIds(c.env.STAFF_USER_IDS).has(user.appUserId);

  // No active org and not staff: refuse, whatever the user's roles. Every new user is given a
  // role, so a roles-only session here would read the home org's bare keys.
  const activeOrgId = resolveActiveOrg(c, memberships, isStaff, user.defaultOrgId) ?? abort(noOrg(c));

  c.set('session', {
    authUserId: user.authUserId, appUserId: user.appUserId, email: user.email, roles,
    ...orgGrant(isStaff, memberships, activeOrgId), activeOrgId, memberships, isStaff,
  });
}

export const authenticate = factory.createMiddleware(async (c, next) => {
  const jwt = bearerToken(c);
  if (applyTestBypass(c, jwt)) return next();
  if (!jwt) return unauthorized(c);

  // One deadline shared across all auth fetches
  const signal = AbortSignal.timeout(AUTH_TIMEOUT_MS);

  const auth0Id = await verifiedAuth0Id(c, jwt);

  if (!c.env.HOME_ORG_ID) {
    // An empty HOME_ORG_ID must never silently resolve or fall back into a production org.
    console.error('[auth] HOME_ORG_ID is empty — refusing to serve');
    return internalError(c);
  }

  const supabase = db(c.env);
  const user = await loadAppUser(c, supabase, auth0Id, signal);

  const [rolesRes, membershipsRes] = await fetchGrants(supabase, user.appUserId, signal);

  if (rolesRes.error) {
    logFailedRead(`role fetch for user ${user.appUserId}`, rolesRes);
    return internalError(c, ERR_FAILED_LOAD_USER_ROLES);
  }
  // Fail closed: a failed read must not pass for "no memberships", which answers a
  // non-retried 403 (or, for staff, the home org).
  if (membershipsRes.error) {
    logFailedRead(`membership fetch for user ${user.appUserId}`, membershipsRes);
    return authUnavailable(c);
  }
  orgScopedSession(c, user, parseRoleNames(rolesRes.data), parseMemberships(membershipsRes.data));
  return next();
});
