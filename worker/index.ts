/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { DashboardPermission, AppSession, DashboardView } from '../src/types/auth.js';
import type { UserActivityEvent } from '../src/types/activity.js';
import { PublicUserSchema, UserRoleRowSchema, MeResponseSchema, ActivityRequestSchema, AdminRoleSchema, AdminUserRoleRowSchema, AdminUserSchema, AssignRoleRequestSchema } from '../src/lib/validation/auth-schemas.js';
import { routingTelemetryKvSchema } from '../src/lib/validation/dashboard-schemas.js';
import { supabasePost } from '../src/lib/supabase-rest.js';

export type { DashboardPermission, AppSession };

// Fire-and-forget: logs activity to user_activity table without blocking the response.
// Failures are intentionally swallowed — audit logging must not fail user requests.
// Auth: uses service role key (Auth0 JWTs are not valid Supabase session tokens for RLS).
function logActivity(
  appUserId: string,
  activityType: UserActivityEvent,
  env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string },
): void {
  supabasePost(
    `${env.SUPABASE_URL}/rest/v1/user_activity`,
    { user_id: appUserId, activity_type: activityType },
    env.SUPABASE_SERVICE_ROLE_KEY,
  );
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
}));

// Cache policy: private, no-store for all /api/* (responses may contain user-specific data)
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

const AUTH_TIMEOUT_MS = 5000;

// JWT auth middleware — runs before all /api/* routes, exempts /api/health and test mode
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();

  const authHeader = c.req.header('Authorization');
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // Test mode: bypass auth when ALLOW_TEST_BYPASS is explicitly enabled in the environment.
  // Never set ALLOW_TEST_BYPASS in production — leave the binding absent.
  if (c.env.ALLOW_TEST_BYPASS === 'true' && jwt === 'test-token') {
    c.set('session', {
      authUserId: 'auth0|test-user',
      appUserId: 'a0000000-0000-4000-8000-000000000002',
      email: 'test@example.com',
      roles: ['test'],
      permissions: ['dashboard.admin'],
      allowedViews: ['executive', 'operator', 'auditor'],
    });
    return next();
  }

  if (!jwt) return c.json({ error: 'Unauthorized' }, 401);

  // Single AbortController shared across all auth fetches; aborts on timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    // Verify JWT via Auth0 JWKS (validates signature, expiry, issuer, audience)
    const JWKS = createRemoteJWKSet(
      new URL(`https://${c.env.AUTH0_DOMAIN}/.well-known/jwks.json`),
    );
    let jwtPayload: Record<string, unknown>;
    try {
      const { payload } = await jwtVerify(jwt, JWKS, {
        issuer: `https://${c.env.AUTH0_DOMAIN}/`,
        audience: c.env.AUTH0_AUDIENCE,
      });
      jwtPayload = payload as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const auth0Id = typeof jwtPayload['sub'] === 'string' ? jwtPayload['sub'] : null;
    if (!auth0Id) return c.json({ error: 'Unauthorized' }, 401);

    // Fetch public.users row by auth0_id — required; users with no app record are rejected
    const userRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/users?select=id,email&auth0_id=eq.${encodeURIComponent(auth0Id)}&limit=1`,
      { headers: serviceRoleHeaders(c.env), signal: controller.signal },
    ).catch(() => null);
    if (!userRes?.ok) return c.json({ error: 'Unauthorized' }, 401);
    const rawUsers: unknown = await userRes.json().catch(() => null);
    if (!Array.isArray(rawUsers) || !rawUsers[0]) return c.json({ error: 'Unauthorized' }, 401);
    const userResult = PublicUserSchema.safeParse(rawUsers[0]);
    if (!userResult.success) return c.json({ error: 'Unauthorized' }, 401);
    const appUserId = userResult.data.id;
    const email = userResult.data.email;
    const authUserId = auth0Id;

    const roles: string[] = [];
    const permissionSet = new Set<DashboardPermission>();
    // Non-fatal — fetch failure leaves user with no permissions; routes will deny
    const rolesRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/user_roles?select=roles(name,permissions)&user_id=eq.${encodeURIComponent(appUserId)}`,
      { headers: serviceRoleHeaders(c.env), signal: controller.signal },
    ).catch(() => null);
    if (rolesRes?.ok) {
      const rawRows: unknown = await rolesRes.json().catch(() => []);
      const rows = Array.isArray(rawRows) ? rawRows : [];
      for (const row of rows) {
        const rowResult = UserRoleRowSchema.safeParse(row);
        if (!rowResult.success || !rowResult.data.roles) continue;
        roles.push(rowResult.data.roles.name);
        for (const perm of rowResult.data.roles.permissions) {
          if (VALID_PERMISSIONS.has(perm)) permissionSet.add(perm as DashboardPermission);
        }
      }
    }

    const permissions = [...permissionSet];
    const allowedViews: DashboardView[] = permissionSet.has('dashboard.admin')
      ? ['executive', 'operator', 'auditor']
      : VIEW_PERMISSION_MAP
          .filter(([perm]) => permissionSet.has(perm))
          .map(([, view]) => view);

    c.set('session', { authUserId, appUserId, email, roles, permissions, allowedViews });
    return next();
  } finally {
    clearTimeout(timeout);
  }
});

// Permission guard helper — returns true if session has the required permission.
// Admins bypass all permission checks via 'dashboard.admin'.
function hasPermission(session: AppSession, permission: DashboardPermission): boolean {
  return session.permissions.includes('dashboard.admin') || session.permissions.includes(permission);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns headers for Supabase REST calls using the service role key (bypasses RLS).
// Both apikey and Authorization use the service role key — the anon key is for browser clients only.
function serviceRoleHeaders(env: { SUPABASE_SERVICE_ROLE_KEY: string }): HeadersInit {
  return {
    'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

app.get('/api/me', (c) => {
  const session = c.get('session');

  // Explicitly construct response to avoid exposing internal IDs (authUserId, appUserId)
  const me = {
    email: session.email,
    roles: session.roles,
    permissions: session.permissions,
    allowedViews: session.allowedViews,
  };

  const meResult = MeResponseSchema.safeParse(me);
  if (!meResult.success) {
    console.error('[/api/me] MeResponseSchema validation failed:', meResult.error.issues);
    return c.json({ error: 'Internal server error' }, 500);
  }
  return c.json(meResult.data);
});

app.post('/api/logout', (c) => {
  const session = c.get('session');
  logActivity(session.appUserId ?? '', 'logout', c.env);
  return c.body(null, 204);
});

app.post('/api/activity', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = ActivityRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: 'Invalid request body' }, 400);
  logActivity(c.get('session').appUserId ?? '', result.data.activity_type as UserActivityEvent, c.env);
  return c.body(null, 204);
});

app.get('/api/dashboard', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const role = c.req.query('role');
  if (role && !['executive', 'operator', 'auditor'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be executive, operator, or auditor.' }, 400);
  }
  if (role && !session.allowedViews.includes(role as DashboardView)) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const key = role ? `dashboard:${period}:${role}` : `dashboard:${period}`;
  const data = await c.env.DASHBOARD.get(key, 'json');
  if (!data) return c.json({ error: 'No data available' }, 404);
  logActivity(session.appUserId ?? '', 'dashboard_view', c.env);
  return c.json(data);
});

app.get('/api/metrics/:name/evaluations', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const name = c.req.param('name');
  if (!name || name.length > 200 || !/^[\w:.-]+$/.test(name)) return c.json({ error: 'Invalid metric name' }, 400);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const limit = Math.min(Math.max(parseInt(c.req.query('limit') ?? '50', 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query('offset') ?? '0', 10) || 0, 0);
  const sortBy = c.req.query('sortBy') ?? 'timestamp_desc';
  const scoreLabel = c.req.query('scoreLabel');

  const data = await c.env.DASHBOARD.get(`metric:evaluations:${name}:${period}`, 'json') as
    | { rows: Record<string, unknown>[] } | null;
  if (!data) return c.json({ rows: [], total: 0, limit, offset, hasMore: false });

  let rows = data.rows;
  if (scoreLabel) rows = rows.filter((r: Record<string, unknown>) => r.label === scoreLabel);
  if (sortBy === 'score_asc') rows.sort((a, b) => ((a.score as number) ?? 0) - ((b.score as number) ?? 0));
  else if (sortBy === 'score_desc') rows.sort((a, b) => ((b.score as number) ?? 0) - ((a.score as number) ?? 0));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return c.json({ rows: page, total, limit, offset, hasMore: offset + limit < total });
});

app.get('/api/metrics/:name', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const name = c.req.param('name');
  if (!name || name.length > 200 || !/^[\w:.-]+$/.test(name)) return c.json({ error: 'Invalid metric name' }, 400);
  const data = await c.env.DASHBOARD.get(`metric:${name}`, 'json');
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
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const name = c.req.param('name');
  if (!name || name.length > 200 || !/^[\w:.-]+$/.test(name)) return c.json({ error: 'Invalid metric name' }, 400);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`trend:${name}:${period}`, 'json');
  if (!data) return c.json({ metric: name, period, points: [], bucketCount: 0 });
  return c.json(data);
});

app.get('/api/evaluations/trace/:traceId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: 'Forbidden' }, 403);
  const traceId = c.req.param('traceId');
  if (!traceId || traceId.length > 200 || !/^[\w:.-]+$/.test(traceId)) return c.json({ error: 'Invalid traceId' }, 400);
  const data = await c.env.DASHBOARD.get(`evaluations:trace:${traceId}`, 'json');
  if (!data) return c.json({ evaluations: [] });
  logActivity(session.appUserId ?? '', 'trace_view', c.env);
  return c.json(data);
});

app.get('/api/traces/:traceId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: 'Forbidden' }, 403);
  const traceId = c.req.param('traceId');
  if (!traceId || traceId.length > 200 || !/^[\w:.-]+$/.test(traceId)) return c.json({ error: 'Invalid traceId' }, 400);
  const data = await c.env.DASHBOARD.get(`trace:${traceId}`, 'json');
  if (!data) return c.json({ error: `No trace data for: ${traceId}` }, 404);
  logActivity(session.appUserId ?? '', 'trace_view', c.env);
  return c.json(data);
});

app.get('/api/correlations', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '30d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`correlations:${period}`, 'json');
  if (!data) return c.json({ correlations: [], metrics: [] });
  return c.json(data);
});

app.get('/api/degradation-signals', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  // Key matches DEGRADATION_KV_KEY in src/lib/quality/quality-constants.ts + period suffix
  const data = await c.env.DASHBOARD.get(`meta/dashboard/degradation-signals:${period}`, 'json');
  if (!data) return c.json({ period, reports: [], computedAt: null });
  return c.json(data);
});

app.get('/api/coverage', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const inputKey = c.req.query('inputKey') ?? 'traceId';
  if (!['traceId', 'sessionId'].includes(inputKey)) {
    return c.json({ error: 'Invalid inputKey. Must be traceId or sessionId.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`coverage:${period}:${inputKey}`, 'json');
  if (!data) return c.json({ period, metrics: [], inputs: [], heatmap: [] });
  return c.json(data);
});

app.get('/api/pipeline', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.pipeline.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`pipeline:${period}`, 'json');
  if (!data) return c.json({ period, stages: [], totalEvaluations: 0 });
  return c.json(data);
});

app.get('/api/sessions/:sessionId', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.sessions.read')) return c.json({ error: 'Forbidden' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId || sessionId.length > 200 || !/^[\w:.-]+$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
  const data = await c.env.DASHBOARD.get(`session:${sessionId}`, 'json');
  if (!data) return c.json({ error: `No session data for: ${sessionId}` }, 404);
  logActivity(session.appUserId ?? '', 'session_view', c.env);
  return c.json(data);
});

app.get('/api/agents', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: 'Forbidden' }, 403);
  const data = await c.env.DASHBOARD.get('meta:agents', 'json');
  if (!data) return c.json([]);
  return c.json(data);
});

app.get('/api/agents/detail/:agentId', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: 'Forbidden' }, 403);
  const agentId = c.req.param('agentId');
  if (!agentId || agentId.length > 200 || !/^[\w:.-]+$/.test(agentId)) {
    return c.json({ error: 'Invalid agentId' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`agent:${agentId}`, 'json');
  if (!data) return c.json({ error: `No data for agent: ${agentId}` }, 404);
  return c.json(data);
});

app.get('/api/agents/:sessionId', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.agents.read')) return c.json({ error: 'Forbidden' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId || sessionId.length > 200 || !/^[\w:.-]+$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
  const session = await c.env.DASHBOARD.get(`session:${sessionId}`, 'json') as Record<string, unknown> | null;
  if (!session) return c.json({ error: `No session data for: ${sessionId}` }, 404);
  return c.json({
    sessionId,
    spans: [],
    evaluation: session['multiAgentEvaluation'] ?? null,
    evaluations: session['evaluations'] ?? [],
    agentMap: {},
  });
});

app.get('/api/compliance/sla', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const dashboard = await c.env.DASHBOARD.get(`dashboard:${period}`, 'json') as Record<string, unknown> | null;
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  logActivity(session.appUserId ?? '', 'compliance_view', c.env);
  const slaResults = (dashboard['slaCompliance'] as unknown[]) ?? [];
  return c.json({
    period,
    results: slaResults,
    noSLAsConfigured: slaResults.length === 0,
  });
});

app.get('/api/compliance/verifications', async (c) => {
  const session = c.get('session');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  logActivity(session.appUserId ?? '', 'compliance_view', c.env);
  return c.json({ period, count: 0, verifications: [] });
});

app.get('/api/calibration', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const data = await c.env.DASHBOARD.get('meta:calibration', 'json');
  if (!data) return c.json({ error: 'No calibration data available' }, 404);
  return c.json(data);
});

app.get('/api/routing-telemetry', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const raw = await c.env.DASHBOARD.get(`routing-telemetry:${period}`, 'json');
  const result = routingTelemetryKvSchema.safeParse(raw ?? {});
  if (!result.success) {
    console.error('[/api/routing-telemetry] schema validation failed:', result.error.issues);
    return c.json({ error: 'Routing telemetry data is malformed' }, 500);
  }
  return c.json({ ...result.data, period });
});

app.get('/api/health', async (c) => {
  const lastSync = await c.env.DASHBOARD.get('meta:lastSync');
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

// Admin error handling policy (ADMIN-P4-3):
// All admin routes (/api/admin/*) return generic error messages on Supabase REST failures,
// e.g. "Failed to fetch users" instead of the raw Supabase error body. This is intentional:
// - The service role key is used, so Supabase error bodies may contain table/column metadata.
// - Generic messages prevent internal schema details from leaking to admin clients.
// - HTTP status is always 500 on upstream failure; 400 for input validation.
// - Supabase errors are swallowed; failures are surfaced only via status code + generic message.
// This policy aligns with sanitizeErrorForResponse used in API routes.

// Admin: list all users with their assigned roles
app.get('/api/admin/users', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.admin')) return c.json({ error: 'Forbidden' }, 403);

  const headers = serviceRoleHeaders(c.env);
  const [usersRes, roleRowsRes] = await Promise.all([
    fetch(`${c.env.SUPABASE_URL}/rest/v1/users?select=id,email,created_at&order=created_at.desc`, { headers }),
    fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles?select=user_id,role_id,roles(id,name)`, { headers }),
  ]);

  if (!usersRes.ok) return c.json({ error: 'Failed to fetch users' }, 500);
  if (!roleRowsRes.ok) return c.json({ error: 'Failed to fetch role assignments' }, 500);
  const rawUsersJson: unknown = await usersRes.json().catch(() => null);
  const rawUsers = Array.isArray(rawUsersJson) ? rawUsersJson : [];
  const rawRoleRowsJson: unknown = await roleRowsRes.json().catch(() => []);
  const rawRoleRows = Array.isArray(rawRoleRowsJson) ? rawRoleRowsJson : [];

  // Build userId → roles map
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
    const parsed = AdminUserSchema.safeParse({
      ...(raw as object),
      roles: rolesByUser.get((raw as { id: string }).id) ?? [],
    });
    if (parsed.success) users.push(parsed.data);
  }

  return c.json(users);
});

// Admin: list all available roles
app.get('/api/admin/roles', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.admin')) return c.json({ error: 'Forbidden' }, 403);

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/roles?select=id,name,permissions&order=name.asc`,
    { headers: serviceRoleHeaders(c.env) },
  );
  if (!res.ok) return c.json({ error: 'Failed to fetch roles' }, 500);

  const rawJson: unknown = await res.json().catch(() => null);
  const rows = Array.isArray(rawJson) ? rawJson : [];
  const roles = rows.flatMap((row) => {
    const parsed = AdminRoleSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
  return c.json(roles);
});

// Admin: assign a role to a user
app.post('/api/admin/users/:userId/roles', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.admin')) return c.json({ error: 'Forbidden' }, 403);

  const userId = c.req.param('userId');
  if (!UUID_PATTERN.test(userId)) return c.json({ error: 'Invalid userId' }, 400);

  const body: unknown = await c.req.json().catch(() => null);
  const result = AssignRoleRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: 'Invalid request body' }, 400);

  const res = await fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles`, {
    method: 'POST',
    headers: { ...(serviceRoleHeaders(c.env) as Record<string, string>), 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: userId, role_id: result.data.role_id }),
  });
  if (!res.ok) return c.json({ error: 'Failed to assign role' }, 500);
  return c.body(null, 204);
});

// Admin: revoke a role from a user
app.delete('/api/admin/users/:userId/roles/:roleId', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.admin')) return c.json({ error: 'Forbidden' }, 403);

  const userId = c.req.param('userId');
  const roleId = c.req.param('roleId');
  if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(roleId)) return c.json({ error: 'Invalid ID' }, 400);

  const res = await fetch(
    `${c.env.SUPABASE_URL}/rest/v1/user_roles?user_id=eq.${encodeURIComponent(userId)}&role_id=eq.${encodeURIComponent(roleId)}`,
    { method: 'DELETE', headers: serviceRoleHeaders(c.env) },
  );
  if (!res.ok) return c.json({ error: 'Failed to revoke role' }, 500);
  return c.body(null, 204);
});

// SPA fallback: serve static assets / index.html for non-API routes
app.get('*', async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
