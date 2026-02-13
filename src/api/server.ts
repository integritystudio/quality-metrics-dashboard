import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { dashboardRoutes } from './routes/dashboard.js';
import { metricsRoutes } from './routes/metrics.js';

const app = new Hono();

app.use('/*', cors({ origin: 'http://localhost:5173' }));

app.route('/api', dashboardRoutes);
app.route('/api', metricsRoutes);

const port = 3001;
console.log(`API server listening on http://127.0.0.1:${port}`);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
