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
import { API_HOST, API_PORT } from './config.js';
import { setCloudBackendFetch } from './parent/backends.js';
import { http1Fetch } from './parent/http1-fetch.js';

// A long-running server: Node's built-in fetch would keep reusing a destroyed
// HTTP/2 session and fail every later cloud read (NODE-FETCH-HTTP2-DEAD-SESSION).
setCloudBackendFetch(http1Fetch);

const app = new Hono();

const ROUTERS = [
  dashboardRoutes,
  metricsRoutes,
  correlationRoutes,
  evaluationRoutes,
  trendRoutes,
  coverageRoutes,
  pipelineRoutes,
  complianceRoutes,
  traceRoutes,
  agentRoutes,
  sessionRoutes,
  qualityRoutes,
];
for (const router of ROUTERS) app.route('/api', router);

serve({ fetch: app.fetch, hostname: API_HOST, port: API_PORT });
