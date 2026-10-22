/**
 * The worker's Hono environment — bindings, session variables, the shared factory — and the
 * guards every route module builds on.
 */

import type { Context, HonoRequest, MiddlewareHandler } from 'hono';
import { createFactory } from 'hono/factory';
import type { z } from 'zod';
import type { AppSession, DashboardPermission } from '../src/types/auth.js';
import { PERMISSION } from '../src/lib/org-rbac.js';
import { HttpStatus } from '../src/lib/http-constants.js';
import { ERR_FORBIDDEN } from './error-messages.js';

export type Bindings = {
  DASHBOARD: KVNamespace;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  // Service role key for all Supabase DB calls (Auth0 JWTs cannot satisfy Supabase RLS).
  // Set via: wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_SERVICE_ROLE_KEY: string;
  AUTH0_DOMAIN: string;    // e.g. "integritystudio.us.auth0.com"
  // Custom domain the same tenant also serves logins on, e.g. "auth.integritystudio.ai"
  // (landing CR70). A token obtained through it carries that host as `iss`, signed by the
  // same key set, so it is accepted as a second issuer against AUTH0_DOMAIN's JWKS.
  // Unset on the dev worker: the dev tenant has no custom domain.
  AUTH0_CUSTOM_DOMAIN?: string;
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
  // Set by requireOrgAdmin: the active org every org-admin route is bound to.
  orgId: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type AppContext = Context<AppEnv>;

export const factory = createFactory<AppEnv>();

export function isOrgScopingEnabled(env: Pick<Bindings, 'ORG_SCOPING_ENABLED'>): boolean {
  return env.ORG_SCOPING_ENABLED === 'true';
}

export function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? val as T[] : [];
}

export function hasPermission(session: AppSession, permission: DashboardPermission): boolean {
  return session.permissions.includes(PERMISSION.admin) || session.permissions.includes(permission);
}

/** Route guard: 403 unless the session holds `permission` (or dashboard.admin). */
export function requirePermission(permission: DashboardPermission): MiddlewareHandler<AppEnv> {
  return factory.createMiddleware(async (c, next) => {
    if (!hasPermission(c.get('session'), permission)) return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
    return next();
  });
}

/**
 * The request's JSON body parsed by `schema`, or null when it is absent, malformed or
 * invalid. Called inside the handler, after its permission and path checks, so a caller
 * without access is refused before its body is read.
 */
export async function readJsonBody<T extends z.ZodType>(req: HonoRequest, schema: T): Promise<z.output<T> | null> {
  const result = schema.safeParse(await req.json().catch(() => null));
  return result.success ? result.data : null;
}
