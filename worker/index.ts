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

app.get('/api/health', async (c) => {
  const lastSync = await c.env.DASHBOARD.get('meta:lastSync');
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

export default app;
