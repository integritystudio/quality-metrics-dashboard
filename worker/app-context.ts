/**
 * The worker's Hono environment — bindings, session variables, the shared factory — and the
 * guards every route module builds on.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createFactory } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import type { AppSession, DashboardPermission } from '../src/types/auth.js';
import { PERMISSION } from '../src/lib/org-rbac.js';
import { HttpStatus } from '../src/lib/http-constants.js';
import { ERR_AUTH_UNAVAILABLE, ERR_FORBIDDEN, ERR_INTERNAL, ERR_INVALID_REQUEST_BODY, ERR_UNAUTHORIZED } from './error-messages.js';

export type Bindings = {
  DASHBOARD: KVNamespace;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Bare hostname, no scheme.
  AUTH0_DOMAIN: string;
  // The tenant's custom login domain: a second accepted `iss`, verified against
  // AUTH0_DOMAIN's JWKS. Unset on the dev worker, whose tenant has none.
  AUTH0_CUSTOM_DOMAIN?: string;
  AUTH0_AUDIENCE: string;
  // 'true' enables the test-token bypass. Never set it in production.
  ALLOW_TEST_BYPASS?: string;
  // Org owning all pre-tenancy data. The auth middleware refuses to serve when it is empty.
  HOME_ORG_ID?: string;
  // JSON array of app user UUIDs: the explicit staff allowlist.
  STAFF_USER_IDS?: string;
  // Set 'true' to switch off the home-org bare-key dual-read fallback.
  ORG_KV_FALLBACK_DISABLED?: string;
};

/** The client's `AppSession` leaves the ids and org fields optional; the auth middleware sets them all. */
export type WorkerSession = Required<AppSession>;

type Variables = {
  session: WorkerSession;
  // Set by requireOrgAdmin: the active org every org-admin route is bound to.
  orgId: string;
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
export type AppContext = Context<AppEnv>;

export const factory = createFactory<AppEnv>();

export function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? val as T[] : [];
}

/** The rows of `data` that satisfy `schema`; a row that does not is dropped. */
export function parseRows<T extends z.ZodType>(schema: T, data: unknown): Array<z.output<T>> {
  return safeArray(data).flatMap((row) => {
    const parsed = schema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function hasPermission(session: AppSession, permission: DashboardPermission): boolean {
  return session.permissions.includes(PERMISSION.admin) || session.permissions.includes(permission);
}

export function unauthorized(c: AppContext): Response {
  return c.json({ error: ERR_UNAUTHORIZED }, HttpStatus.Unauthorized);
}

export function forbidden(c: AppContext): Response {
  return c.json({ error: ERR_FORBIDDEN }, HttpStatus.Forbidden);
}

/** 503: the client retries it, as it never retries a 401. */
export function authUnavailable(c: AppContext): Response {
  return c.json({ error: ERR_AUTH_UNAVAILABLE }, HttpStatus.ServiceUnavailable);
}

export function internalError(c: AppContext): Response {
  return c.json({ error: ERR_INTERNAL }, HttpStatus.InternalServerError);
}

/** Ends the request with `response` from any depth; the app's `onError` returns it unchanged. */
export function abort(response: Response): never {
  throw new HTTPException(response.status as ContentfulStatusCode, { res: response });
}

/** Route guard: 403 unless the session holds `permission` (or dashboard.admin). */
export function requirePermission(permission: DashboardPermission): MiddlewareHandler<AppEnv> {
  return factory.createMiddleware(async (c, next) => {
    if (!hasPermission(c.get('session'), permission)) return forbidden(c);
    return next();
  });
}

/** Route guard: 400 with `error` unless the path parameter `name` matches `pattern`. */
export function requireParam(name: string, pattern: RegExp, error: string): MiddlewareHandler<AppEnv> {
  return factory.createMiddleware(async (c, next) => {
    if (!pattern.test(c.req.param(name) ?? '')) return c.json({ error }, HttpStatus.BadRequest);
    return next();
  });
}

/**
 * The request's JSON body parsed by `schema`; an absent, malformed or invalid one ends the
 * request with a 400. Called inside the handler, after its permission and path checks, so a caller
 * without access is refused before its body is read.
 */
export async function readJsonBody<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.output<T>> {
  const result = schema.safeParse(await c.req.json().catch(() => null));
  return result.success ? result.data : abort(c.json({ error: ERR_INVALID_REQUEST_BODY }, HttpStatus.BadRequest));
}
