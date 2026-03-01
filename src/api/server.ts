import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { dashboardRoutes } from './routes/dashboard.js';
import { metricsRoutes } from './routes/metrics.js';
import { correlationRoutes } from './routes/correlations.js';
import { evaluationRoutes } from './routes/evaluations.js';
import { trendRoutes } from './routes/trends.js';
import { coverageRoutes } from './routes/coverage.js';
import { pipelineRoutes } from './routes/pipeline.js';
import { complianceRoutes } from './routes/compliance.js';
import { traceRoutes } from './routes/traces.js';
import { agentRoutes } from './routes/agents.js';
import { sessionRoutes } from './routes/sessions.js';
import { qualityRoutes } from './routes/quality.js';
import { API_HOST, API_PORT } from '../lib/constants.js';

const app = new Hono();

app.use('/*', cors({ origin: process.env.CORS_ORIGIN || 'http://localhost:5173' }));

app.route('/api', dashboardRoutes);
app.route('/api', metricsRoutes);
app.route('/api', correlationRoutes);
app.route('/api', evaluationRoutes);
app.route('/api', trendRoutes);
app.route('/api', coverageRoutes);
app.route('/api', pipelineRoutes);
app.route('/api', complianceRoutes);
app.route('/api', traceRoutes);
app.route('/api', agentRoutes);
app.route('/api', sessionRoutes);
app.route('/api', qualityRoutes);

console.log(`API server listening on http://${API_HOST}:${API_PORT}`);

serve({ fetch: app.fetch, hostname: API_HOST, port: API_PORT });
