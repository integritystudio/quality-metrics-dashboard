import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { dashboardRoutes } from './routes/dashboard.js';
import { metricsRoutes } from './routes/metrics.js';
import { correlationRoutes } from './routes/correlations.js';

const app = new Hono();

app.use('/*', cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));

app.route('/api', dashboardRoutes);
app.route('/api', metricsRoutes);
app.route('/api', correlationRoutes);

const port = 3001;
console.log(`API server listening on http://127.0.0.1:${port}`);

serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
