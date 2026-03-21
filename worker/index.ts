/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DashboardPermission, AppSession, DashboardView } from '../src/types/auth.js';
import { AuthUserResponseSchema, PublicUserSchema, UserRoleRowSchema, MeResponseSchema, ActivityRequestSchema, AdminRoleSchema, AdminUserRoleRowSchema, AdminUserSchema, AssignRoleRequestSchema } from '../src/lib/validation/auth-schemas.js';

export type { DashboardPermission, AppSession };

const USER_ACTIVITY_EVENTS = ['login', 'logout', 'dashboard_view', 'trace_view', 'session_view', 'compliance_view'] as const;
type UserActivityEvent = typeof USER_ACTIVITY_EVENTS[number];

// Fire-and-forget: logs activity to user_activity table without blocking the response.
// Failures are intentionally swallowed — audit logging must not fail user requests.
// 3s timeout prevents hung fetch from blocking worker execution on slow/unreliable networks.
function logActivity(
  appUserId: string,
  activityType: UserActivityEvent,
  env: { SUPABASE_URL: string; SUPABASE_ANON_KEY: string },
  jwt: string,
): void {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  void fetch(`${env.SUPABASE_URL}/rest/v1/user_activity`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ user_id: appUserId, activity_type: activityType }),
    signal: controller.signal,
  }).catch(() => undefined).finally(() => clearTimeout(timeout));
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
  SUPABASE_ANON_KEY: string;
  // Service role key required for admin routes (bypasses RLS).
  // Set via: wrangler secret put SUPABASE_SERVICE_ROLE_KEY
  SUPABASE_SERVICE_ROLE_KEY: string;
};

type Variables = {
  session: AppSession;
  jwt: string;
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

// JWT auth middleware — runs before all /api/* routes, exempts /api/health
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();

  const authHeader = c.req.header('Authorization');
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return c.json({ error: 'Unauthorized' }, 401);

  // Single AbortController shared across all auth fetches; aborts on timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  try {
    // Verify JWT via Supabase /auth/v1/user
    let authUserId: string;
    try {
      const verifyRes = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'apikey': c.env.SUPABASE_ANON_KEY,
        },
        signal: controller.signal,
      });
      if (!verifyRes.ok) return c.json({ error: 'Unauthorized' }, 401);
      const authUserResult = AuthUserResponseSchema.safeParse(await verifyRes.json());
      if (!authUserResult.success) return c.json({ error: 'Unauthorized' }, 401);
      authUserId = authUserResult.data.id;
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    // Fetch public.users row — required; auth users with no app record are rejected with 401
    let email = '';
    let appUserId = '';
    try {
      const userRes = await fetch(
        `${c.env.SUPABASE_URL}/rest/v1/users?select=id,email&id=eq.${encodeURIComponent(authUserId)}&limit=1`,
        {
          headers: {
            'apikey': c.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${jwt}`,
          },
          signal: controller.signal,
        },
      );
      if (!userRes.ok) return c.json({ error: 'Unauthorized' }, 401);
      const users = await userRes.json() as Array<unknown>;
      if (!Array.isArray(users) || !users[0]) return c.json({ error: 'Unauthorized' }, 401);
      const userResult = PublicUserSchema.safeParse(users[0]);
      if (!userResult.success) return c.json({ error: 'Unauthorized' }, 401);
      appUserId = userResult.data.id;
      email = userResult.data.email;
    } catch {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const roles: string[] = [];
    const permissionSet = new Set<DashboardPermission>();
    try {
      const rolesRes = await fetch(
        `${c.env.SUPABASE_URL}/rest/v1/user_roles?select=roles(name,permissions)&user_id=eq.${encodeURIComponent(appUserId)}`,
        {
          headers: {
            'apikey': c.env.SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${jwt}`,
          },
          signal: controller.signal,
        },
      );
      if (rolesRes.ok) {
        const rows = await rolesRes.json() as Array<unknown>;
        for (const row of rows) {
          const rowResult = UserRoleRowSchema.safeParse(row);
          if (!rowResult.success || !rowResult.data.roles) continue;
          roles.push(rowResult.data.roles.name);
          for (const perm of rowResult.data.roles.permissions) {
            if (VALID_PERMISSIONS.has(perm)) {
              permissionSet.add(perm as DashboardPermission);
            }
          }
        }
      }
    } catch {
      // Non-fatal — user will have no permissions, routes will deny
    }
    const permissions = [...permissionSet];
    const isAdmin = permissionSet.has('dashboard.admin');
    const allowedViews: DashboardView[] = isAdmin
      ? ['executive', 'operator', 'auditor']
      : VIEW_PERMISSION_MAP
          .filter(([perm]) => permissionSet.has(perm))
          .map(([, view]) => view);

    c.set('session', { authUserId, appUserId, email, roles, permissions, allowedViews });
    c.set('jwt', jwt);
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
function serviceRoleHeaders(env: { SUPABASE_SERVICE_ROLE_KEY: string; SUPABASE_ANON_KEY: string }): HeadersInit {
  return {
    'apikey': env.SUPABASE_ANON_KEY,
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
  if (!meResult.success) return c.json({ error: 'Internal server error' }, 500);
  return c.json(meResult.data);
});

app.post('/api/activity', async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  const result = ActivityRequestSchema.safeParse(body);
  if (!result.success) return c.json({ error: 'Invalid request body' }, 400);
  logActivity(c.get('session').appUserId, result.data.activity_type, c.env, c.get('jwt'));
  return c.body(null, 204);
});

app.get('/api/dashboard', async (c) => {
  const session = c.get('session');
  const jwt = c.get('jwt');
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
  logActivity(session.appUserId, 'dashboard_view', c.env, jwt);
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
  const jwt = c.get('jwt');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: 'Forbidden' }, 403);
  const traceId = c.req.param('traceId');
  if (!traceId || traceId.length > 200 || !/^[\w:.-]+$/.test(traceId)) return c.json({ error: 'Invalid traceId' }, 400);
  const data = await c.env.DASHBOARD.get(`evaluations:trace:${traceId}`, 'json');
  if (!data) return c.json({ evaluations: [] });
  logActivity(session.appUserId, 'trace_view', c.env, jwt);
  return c.json(data);
});

app.get('/api/traces/:traceId', async (c) => {
  const session = c.get('session');
  const jwt = c.get('jwt');
  if (!hasPermission(session, 'dashboard.traces.read')) return c.json({ error: 'Forbidden' }, 403);
  const traceId = c.req.param('traceId');
  if (!traceId || traceId.length > 200 || !/^[\w:.-]+$/.test(traceId)) return c.json({ error: 'Invalid traceId' }, 400);
  const data = await c.env.DASHBOARD.get(`trace:${traceId}`, 'json');
  if (!data) return c.json({ error: `No trace data for: ${traceId}` }, 404);
  logActivity(session.appUserId, 'trace_view', c.env, jwt);
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
  const jwt = c.get('jwt');
  if (!hasPermission(session, 'dashboard.sessions.read')) return c.json({ error: 'Forbidden' }, 403);
  const sessionId = c.req.param('sessionId');
  if (!sessionId || sessionId.length > 200 || !/^[\w:.-]+$/.test(sessionId)) return c.json({ error: 'Invalid sessionId' }, 400);
  const data = await c.env.DASHBOARD.get(`session:${sessionId}`, 'json');
  if (!data) return c.json({ error: `No session data for: ${sessionId}` }, 404);
  logActivity(session.appUserId, 'session_view', c.env, jwt);
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
  const jwt = c.get('jwt');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const dashboard = await c.env.DASHBOARD.get(`dashboard:${period}`, 'json') as Record<string, unknown> | null;
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  logActivity(session.appUserId, 'compliance_view', c.env, jwt);
  return c.json({
    period,
    results: (dashboard['slaCompliance'] as unknown[]) ?? [],
    noSLAsConfigured: !dashboard['slaCompliance'] || (dashboard['slaCompliance'] as unknown[]).length === 0,
  });
});

app.get('/api/compliance/verifications', async (c) => {
  const session = c.get('session');
  const jwt = c.get('jwt');
  if (!hasPermission(session, 'dashboard.compliance.read')) return c.json({ error: 'Forbidden' }, 403);
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  logActivity(session.appUserId, 'compliance_view', c.env, jwt);
  return c.json({ period, count: 0, verifications: [] });
});

app.get('/api/calibration', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.read')) return c.json({ error: 'Forbidden' }, 403);
  const data = await c.env.DASHBOARD.get('meta:calibration', 'json');
  if (!data) return c.json({ error: 'No calibration data available' }, 404);
  return c.json(data);
});

app.get('/api/health', async (c) => {
  const lastSync = await c.env.DASHBOARD.get('meta:lastSync');
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

// Admin: list all users with their assigned roles
app.get('/api/admin/users', async (c) => {
  if (!hasPermission(c.get('session'), 'dashboard.admin')) return c.json({ error: 'Forbidden' }, 403);

  const headers = serviceRoleHeaders(c.env);
  const [usersRes, roleRowsRes] = await Promise.all([
    fetch(`${c.env.SUPABASE_URL}/rest/v1/users?select=id,email,created_at&order=created_at.desc`, { headers }),
    fetch(`${c.env.SUPABASE_URL}/rest/v1/user_roles?select=user_id,role_id,roles(id,name)`, { headers }),
  ]);

  if (!usersRes.ok) return c.json({ error: 'Failed to fetch users' }, 500);
  const rawUsers = await usersRes.json() as Array<unknown>;
  const rawRoleRows = roleRowsRes.ok ? await roleRowsRes.json() as Array<unknown> : [];

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

  const rows = await res.json() as Array<unknown>;
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
    headers: { ...serviceRoleHeaders(c.env) as Record<string, string>, 'Prefer': 'return=minimal' },
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
