/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DashboardPermission, AppSession, MeResponse } from '../src/types/auth.js';

export type { DashboardPermission, AppSession };

type Bindings = {
  DASHBOARD: KVNamespace;
  ASSETS: Fetcher;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

type Variables = {
  session: AppSession;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

app.use('/*', cors({
  origin: ['https://integritystudio.dev', 'https://www.aledlie.com', 'https://aledlie.com'],
  allowMethods: ['GET', 'POST'],
}));

// Cache policy: private, no-store for all /api/* (responses may contain user-specific data)
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

// JWT auth middleware — runs before all /api/* routes, exempts /api/health
app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/health') return next();

  const authHeader = c.req.header('Authorization');
  const jwt = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!jwt) return c.json({ error: 'Unauthorized' }, 401);

  // Verify JWT via Supabase /auth/v1/user
  let authUserId: string;
  try {
    const verifyRes = await fetch(`${c.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'apikey': c.env.SUPABASE_ANON_KEY,
      },
    });
    if (!verifyRes.ok) return c.json({ error: 'Unauthorized' }, 401);
    const authUser = await verifyRes.json() as { id: string };
    authUserId = authUser.id;
  } catch {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Fetch public.users row
  let email = '';
  let appUserId = authUserId;
  try {
    const userRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/users?select=id,email&id=eq.${authUserId}&limit=1`,
      {
        headers: {
          'apikey': c.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${jwt}`,
        },
      },
    );
    if (userRes.ok) {
      const users = await userRes.json() as Array<{ id: string; email: string }>;
      if (users[0]) {
        appUserId = users[0].id;
        email = users[0].email;
      }
    }
  } catch {
    // Non-fatal — proceed with auth user info only
  }

  const roles: string[] = [];
  const permissionSet = new Set<DashboardPermission>();
  try {
    const rolesRes = await fetch(
      `${c.env.SUPABASE_URL}/rest/v1/user_roles?select=roles(name,permissions)&user_id=eq.${appUserId}`,
      {
        headers: {
          'apikey': c.env.SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${jwt}`,
        },
      },
    );
    if (rolesRes.ok) {
      const rows = await rolesRes.json() as Array<{ roles: { name: string; permissions: string[] } | null }>;
      for (const row of rows) {
        if (!row.roles) continue;
        roles.push(row.roles.name);
        for (const perm of row.roles.permissions) {
          permissionSet.add(perm as DashboardPermission);
        }
      }
    }
  } catch {
    // Non-fatal — user will have no permissions, routes will deny
  }
  const permissions = [...permissionSet];

  c.set('session', { authUserId, appUserId, email, roles, permissions });
  return next();
});

app.post('/api/me', (c) => {
  const session = c.get('session');
  const allowedViews: Array<'executive' | 'operator' | 'auditor'> = [];

  if (session.permissions.includes('dashboard.admin')) {
    allowedViews.push('executive', 'operator', 'auditor');
  } else {
    if (session.permissions.includes('dashboard.executive')) allowedViews.push('executive');
    if (session.permissions.includes('dashboard.operator')) allowedViews.push('operator');
    if (session.permissions.includes('dashboard.auditor')) allowedViews.push('auditor');
  }

  const response: MeResponse = {
    email: session.email,
    roles: session.roles,
    permissions: session.permissions,
    allowedViews,
  };
  return c.json(response);
});

app.get('/api/dashboard', async (c) => {
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const role = c.req.query('role');
  if (role && !['executive', 'operator', 'auditor'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be executive, operator, or auditor.' }, 400);
  }

  const key = role ? `dashboard:${period}:${role}` : `dashboard:${period}`;
  const data = await c.env.DASHBOARD.get(key, 'json');
  if (!data) return c.json({ error: 'No data available' }, 404);
  return c.json(data);
});

app.get('/api/metrics/:name/evaluations', async (c) => {
  const name = c.req.param('name');
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
  const name = c.req.param('name');
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
  const name = c.req.param('name');
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`trend:${name}:${period}`, 'json');
  if (!data) return c.json({ metric: name, period, points: [], bucketCount: 0 });
  return c.json(data);
});

app.get('/api/evaluations/trace/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  const data = await c.env.DASHBOARD.get(`evaluations:trace:${traceId}`, 'json');
  if (!data) return c.json({ evaluations: [] });
  return c.json(data);
});

app.get('/api/traces/:traceId', async (c) => {
  const traceId = c.req.param('traceId');
  const data = await c.env.DASHBOARD.get(`trace:${traceId}`, 'json');
  if (!data) return c.json({ error: `No trace data for: ${traceId}` }, 404);
  return c.json(data);
});

app.get('/api/correlations', async (c) => {
  const period = c.req.query('period') ?? '30d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`correlations:${period}`, 'json');
  if (!data) return c.json({ correlations: [], metrics: [] });
  return c.json(data);
});

app.get('/api/degradation-signals', async (c) => {
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
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`pipeline:${period}`, 'json');
  if (!data) return c.json({ period, stages: [], totalEvaluations: 0 });
  return c.json(data);
});

app.get('/api/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  const data = await c.env.DASHBOARD.get(`session:${sessionId}`, 'json');
  if (!data) return c.json({ error: `No session data for: ${sessionId}` }, 404);
  return c.json(data);
});

app.get('/api/agents', async (c) => {
  const data = await c.env.DASHBOARD.get('meta:agents', 'json');
  if (!data) return c.json([]);
  return c.json(data);
});

app.get('/api/agents/detail/:agentId', async (c) => {
  const agentId = c.req.param('agentId');
  if (!agentId || agentId.length > 200 || !/^[\w:.-]+$/.test(agentId)) {
    return c.json({ error: 'Invalid agentId' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`agent:${agentId}`, 'json');
  if (!data) return c.json({ error: `No data for agent: ${agentId}` }, 404);
  return c.json(data);
});

app.get('/api/agents/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
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
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const dashboard = await c.env.DASHBOARD.get(`dashboard:${period}`, 'json') as Record<string, unknown> | null;
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  return c.json({
    period,
    results: (dashboard['slaCompliance'] as unknown[]) ?? [],
    noSLAsConfigured: !dashboard['slaCompliance'] || (dashboard['slaCompliance'] as unknown[]).length === 0,
  });
});

app.get('/api/compliance/verifications', async (c) => {
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  return c.json({ period, count: 0, verifications: [] });
});

app.get('/api/calibration', async (c) => {
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

// SPA fallback: serve static assets / index.html for non-API routes
app.get('*', async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
