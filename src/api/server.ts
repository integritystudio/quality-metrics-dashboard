import { Hono } from 'hono';
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
import { codeQualityRoutes } from './routes/code-quality.js';
import { API_HOST, API_PORT } from './config.js';
import { setCloudBackendFetch } from './parent/backends.js';
import { http1Fetch } from './parent/http1-fetch.js';

// A long-running server: Node's built-in fetch would keep reusing a destroyed
// HTTP/2 session and fail every later cloud read (NODE-FETCH-HTTP2-DEAD-SESSION).
setCloudBackendFetch(http1Fetch);

const app = new Hono();

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
app.route('/api', codeQualityRoutes);

serve({ fetch: app.fetch, hostname: API_HOST, port: API_PORT });
