import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = { DASHBOARD: KVNamespace };

const app = new Hono<{ Bindings: Bindings }>();

app.use('/*', cors({
  origin: ['https://integritystudio.dev', 'https://www.aledlie.com', 'https://aledlie.com'],
  allowMethods: ['GET'],
}));

app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, max-age=300');
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

app.get('/api/metrics/:name', async (c) => {
  const name = c.req.param('name');
  const data = await c.env.DASHBOARD.get(`metric:${name}`, 'json');
  if (!data) return c.json({ error: `No data for metric: ${name}` }, 404);
  return c.json(data);
});

app.get('/api/trends/:name', async (c) => {
  const name = c.req.param('name');
  const period = c.req.query('period') ?? '7d';
  if (!['24h', '7d', '30d'].includes(period)) {
    return c.json({ error: 'Invalid period. Must be 24h, 7d, or 30d.' }, 400);
  }
  const data = await c.env.DASHBOARD.get(`trend:${name}:${period}`, 'json');
  if (!data) return c.json({ error: `No trend data for metric: ${name}` }, 404);
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

app.get('/api/health', async (c) => {
  const lastSync = await c.env.DASHBOARD.get('meta:lastSync');
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

export default app;
