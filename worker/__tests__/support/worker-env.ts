/**
 * The Worker bindings and execution context the route tests hand to `app.request`.
 *
 * Each call builds fresh bindings, so no test sees another's KV writes or ASSETS calls.
 */
import { HttpStatus } from '../../../src/lib/http-constants.js';
import type { OrgMembershipRole } from '../../../src/types/auth.js';
import { MemoryKv } from './memory-kv.js';
import { TEST_AUDIENCE, TEST_AUTH0_DOMAIN } from './jwt.js';

const TEST_SUPABASE_URL = 'https://test.supabase.co';
export const TEST_SERVICE_ROLE_KEY = 'test-service-role-key';
const SPA_PLACEHOLDER_BODY = 'SPA';
const BYPASS_TOKEN = 'test-token';

/** A STAFF_USER_IDS value naming no staff. */
export const NO_STAFF_USER_IDS = '[]';

/** The org the worker's ALLOW_TEST_BYPASS session acts in. */
export const BYPASS_ORG_ID = 'a0000000-0000-4000-8000-000000000001';

/** ALLOW_TEST_BYPASS on, with both production markers (HOME_ORG_ID, staff list) absent, as on the dev worker. */
export const BYPASS_BINDINGS = { ALLOW_TEST_BYPASS: 'true', HOME_ORG_ID: '', STAFF_USER_IDS: NO_STAFF_USER_IDS };

/** The home org of a worker serving signed sessions, and the org its signed-in test user belongs to. */
export const TEST_HOME_ORG_ID = 'a0000000-0000-4000-8000-0000000000aa';
export const TEST_MEMBER_ORG_ID = 'a0000000-0000-4000-8000-0000000000bb';

/** What the auth middleware needs to serve a signed session: a home org, and nobody on staff. */
export const ORG_BINDINGS = { HOME_ORG_ID: TEST_HOME_ORG_ID, STAFF_USER_IDS: NO_STAFF_USER_IDS };

/** ORG_BINDINGS with `appUserId` on the staff allowlist. */
export function staffBindings(appUserId: string) {
  return { HOME_ORG_ID: TEST_HOME_ORG_ID, STAFF_USER_IDS: JSON.stringify([appUserId]) };
}

/** The `organization_memberships` rows PostgREST answers for one membership of `orgId` holding `role`. */
export function membershipRows(role: OrgMembershipRole, orgId: string = TEST_MEMBER_ORG_ID) {
  return [{ role, organization_id: orgId, organizations: { id: orgId, slug: 'test-org', name: 'Test Org' } }];
}

/** A KV holding `entries` under the keys the worker reads for a session acting in `orgId`. */
export function orgKv(orgId: string, entries: Record<string, unknown> = {}): MemoryKv {
  return new MemoryKv(Object.fromEntries(Object.entries(entries).map(([key, value]) => [`org:${orgId}:${key}`, value])));
}

/** Request headers carrying the bearer token the bypass accepts. */
export const BYPASS_HEADERS = { Authorization: `Bearer ${BYPASS_TOKEN}` };

/** An ASSETS binding that answers every request with a placeholder SPA page. */
function spaAssets() {
  return { fetch: () => Promise.resolve(new Response(SPA_PLACEHOLDER_BODY, { status: HttpStatus.Ok })) };
}

/** An empty KV, the placeholder SPA, the test Supabase project and the test Auth0 tenant; `overrides` replaces or adds bindings. */
export function makeWorkerEnv(overrides: Record<string, unknown> = {}) {
  return {
    DASHBOARD: new MemoryKv(),
    ASSETS: spaAssets(),
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_ROLE_KEY,
    AUTH0_DOMAIN: TEST_AUTH0_DOMAIN,
    AUTH0_AUDIENCE: TEST_AUDIENCE,
    ...overrides,
  };
}

/** An execution context that drops what it is handed. */
export function makeCtx(): ExecutionContext {
  return { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
}
