/**
 * The Worker bindings and execution context the route tests hand to `app.request`.
 *
 * Each call builds fresh bindings, so no test sees another's KV writes or ASSETS calls.
 */
import { HttpStatus } from '../../../src/lib/http-constants.js';
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
