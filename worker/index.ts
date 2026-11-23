import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { UserActivityEvent } from '../src/types/activity.js';
import type { TrendView } from '../src/api/aggregates/trend.js';
import { MeResponseSchema, ActivityRequestSchema, OrgSwitchRequestSchema } from '../src/lib/validation/auth-schemas.js';
import { PERMISSION } from '../src/lib/org-rbac.js';
import {
  AGENT_STATS_KEY_PREFIX,
  METRIC_DETAIL_KEY_PREFIX,
  ORG_ID_HEADER,
  QUALITY_LIVE_PERIOD,
  TREND_KEY_PREFIX,
  WORKER_ERR_NO_DATA,
  WORKER_ERR_NO_CALIBRATION_DATA,
} from '../src/lib/worker-contract.js';
import { summarizeQualityLive, type LiveEvaluation } from '../src/lib/quality-live.js';
import { routingTelemetryKvSchema, calibrationResponseSchema } from '../src/lib/validation/dashboard-schemas.js';
import { CONTENT_TYPE_HEADER, HttpStatus } from '../src/lib/http-constants.js';
import { queryValidator, requireParam } from '../src/lib/query-validator.js';
import { DEFAULT_PERIOD, DEFAULT_PERIOD_DETAIL } from '../src/lib/periods.js';
import {
  ERR_INVALID_METRIC_NAME,
  ERR_INVALID_QUERY,
  ERR_INVALID_SESSION_ID,
  ERR_INVALID_TRACE_ID,
  ID_PATTERN,
  InputKeySchema,
  LimitSchema,
  OffsetSchema,
  QUERY_FIELD_ERRORS,
  SortBySchema,
  periodQuery,
} from '../src/lib/query-schemas.js';
import { RoleSchema } from '../src/lib/roles.js';
import {
  abort,
  factory,
  forbidden,
  internalError,
  readJsonBody,
  requirePermission,
  safeArray,
  type AppContext,
  type AppEnv,
  type WorkerSession,
} from './app-context.js';
import { db, logActivity } from './supabase.js';
import { authenticate, canEnterOrg, orgGrant } from './auth.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerJudgeConfigRoutes } from './judge-config-routes.js';
import {
  ERR_CALIBRATION_MALFORMED,
  ERR_INTERNAL,
  ERR_INVALID_AGENT_ID,
  ERR_ROUTING_TELEMETRY_MALFORMED,
} from './error-messages.js';

const PeriodQuery = periodQuery(DEFAULT_PERIOD);
const WidePeriodQuery = periodQuery(DEFAULT_PERIOD_DETAIL);
const DashboardQuery = PeriodQuery.extend({
  // An empty ?role= means "no role".
  role: RoleSchema.or(z.literal('')).optional(),
});
const MetricEvaluationsQuery = PeriodQuery.extend({
  limit: LimitSchema,
  offset: OffsetSchema,
  sortBy: SortBySchema,
  scoreLabel: z.string().optional(),
});
const CoverageQuery = PeriodQuery.extend({
  inputKey: InputKeySchema,
});

const KV_SCHEMA_VERSION = 1;

function requireId(param: string, error: string): MiddlewareHandler<AppEnv> {
  return requireParam<AppEnv>(param, ID_PATTERN, error);
}

const canRead = requirePermission(PERMISSION.read);
const canReadAgents = requirePermission(PERMISSION.agents);
const canReadTraces = requirePermission(PERMISSION.traces);
const canReadCompliance = requirePermission(PERMISSION.compliance);
const requireMetricName = requireId('name', ERR_INVALID_METRIC_NAME);
const requireSessionId = requireId('sessionId', ERR_INVALID_SESSION_ID);
const requireTraceId = requireId('traceId', ERR_INVALID_TRACE_ID);

/**
 * Reads a KV entry and unwraps the `{ v, data }` envelope every KV writer uses. A version
 * mismatch reads as missing; an entry with no envelope passes through as is.
 * Private: routes go through getKv (org choke point) or getGlobalKv (allowlist).
 */
async function readKvEnvelope<T>(kv: KVNamespace, key: string): Promise<T | null> {
  const raw: unknown = await kv.get(key, 'json');
  if (raw === null) return null;
  if (typeof raw === 'object' && 'v' in raw && 'data' in raw) {
    if (raw.v !== KV_SCHEMA_VERSION) {
      console.warn(`[kv] schema version mismatch for "${key}": expected ${KV_SCHEMA_VERSION}, got ${String(raw.v)} — treating as missing`);
      return null;
    }
    return raw.data as T;
  }
  return raw as T;
}

/** Logged on every bare-key fallback; the fallback can be retired once this stays at zero. */
let kvFallbackHits = 0;

type OrgKvEnv = { HOME_ORG_ID?: string; ORG_KV_FALLBACK_DISABLED?: string };

/**
 * The single org-scoped KV choke point: reads `org:<orgId>:<key>`. On a miss the home org
 * alone falls back to the bare key, unless ORG_KV_FALLBACK_DISABLED: an un-synced tenant org
 * must never read the home org's data.
 */
async function getKv<T>(kv: KVNamespace, orgId: string, key: string, env: OrgKvEnv): Promise<T | null> {
  const scoped = await readKvEnvelope<T>(kv, `org:${orgId}:${key}`);
  if (scoped !== null) return scoped;
  if (env.ORG_KV_FALLBACK_DISABLED !== 'true' && env.HOME_ORG_ID && orgId === env.HOME_ORG_ID) {
    const legacy = await readKvEnvelope<T>(kv, key);
    if (legacy !== null) {
      kvFallbackHits++;
      console.log(`[kv] kv_fallback_hits=${kvFallbackHits} key="${key}" (bare-key fallback, home org)`);
      return legacy;
    }
  }
  return null;
}

/** System keys readable without a session; any other unprefixed read is a defect. */
const GLOBAL_KV_ALLOWLIST = new Set(['system:lastSync']);

async function getGlobalKv<T>(kv: KVNamespace, key: string): Promise<T | null> {
  if (!GLOBAL_KV_ALLOWLIST.has(key)) {
    console.error(`[kv] getGlobalKv called with non-allowlisted key "${key}" — refusing`);
    return null;
  }
  return readKvEnvelope<T>(kv, key);
}

const app = factory.createApp();

// A handler that throws gets the same JSON error shape as every handled failure, not Hono's
// plain-text default. An HTTPException carries the response it means; the rest is a 500.
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(`[worker] unhandled error on ${c.req.method} ${c.req.path}:`, err instanceof Error ? err.message : String(err));
  return internalError(c);
});

app.use('/*', cors({
  origin: [
    'https://integritystudio.dev',
    'https://www.aledlie.com',
    'https://aledlie.com',
  ],
  // Bearer JWT auth on all /api/* routes prevents CSRF: browsers cannot set a custom
  // Authorization header on a cross-site request.
  allowMethods: ['GET', 'POST', 'DELETE'],
  // X-Org-Id is membership-validated in the auth middleware, never trusted as sent.
  allowHeaders: ['Authorization', CONTENT_TYPE_HEADER, ORG_ID_HEADER],
}));

// Responses may contain user-specific data.
app.use('/api/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'private, no-store');
});

// Session-less, so registered before the auth middleware: a handler that answers ends the chain.
app.get('/api/health', async (c) => {
  // It must never touch an org-prefixed key, so it reads the allowlisted global heartbeat
  // that the KV sync Workflow writes alongside the per-org lastSync keys.
  const lastSync = await getGlobalKv<string>(c.env.DASHBOARD, 'system:lastSync');
  return c.json({
    status: lastSync ? 'ok' : 'no_data',
    lastSync: lastSync ?? null,
  });
});

app.use('/api/*', authenticate);

function validQuery<T extends z.ZodType>(schema: T): ReturnType<typeof queryValidator<T>> {
  return queryValidator(schema, QUERY_FIELD_ERRORS, ERR_INVALID_QUERY);
}

/** Session-scoped KV read used by every /api/* data route. */
async function getSessionKv<T>(c: AppContext, key: string): Promise<T | null> {
  return getKv<T>(c.env.DASHBOARD, c.get('session').activeOrgId, key, c.env);
}

/** The session's KV entry as JSON, or `missing()` when the key holds nothing; `activity` is logged on a hit. */
async function kvJson(c: AppContext, key: string, missing: () => Response, activity?: UserActivityEvent): Promise<Response> {
  const data = await getSessionKv<object>(c, key);
  if (!data) return missing();
  if (activity) logActivity(c, activity);
  return c.json(data);
}

/** The KV entry, or `empty`: a shape the page can render before any sync has written the key. */
async function kvOr(c: AppContext, key: string, empty: object, activity?: UserActivityEvent): Promise<Response> {
  return kvJson(c, key, () => c.json(empty), activity);
}

async function kvOr404(c: AppContext, key: string, error: string, activity?: UserActivityEvent): Promise<Response> {
  return kvJson(c, key, () => c.json({ error }, HttpStatus.NotFound), activity);
}

/** `raw` parsed by `schema`; a payload that fails it is logged and answered 500 with `error`. */
function parsedOrAbort<T extends z.ZodType>(c: AppContext, schema: T, raw: unknown, error: string): z.output<T> {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  console.error(`[${c.req.path}] schema validation failed:`, result.error.issues);
  return abort(internalError(c, error));
}

// Built field by field so the internal ids (authUserId, appUserId) never leave the worker.
function buildMePayload(session: WorkerSession): Record<string, unknown> {
  return {
    email: session.email,
    roles: session.roles,
    permissions: session.permissions,
    allowedViews: session.allowedViews,
    activeOrg: session.activeOrgId,
    memberships: session.memberships,
    role: session.role,
    isStaff: session.isStaff,
  };
}

function respondMe(c: AppContext, session: WorkerSession): Response {
  return c.json(parsedOrAbort(c, MeResponseSchema, buildMePayload(session), ERR_INTERNAL));
}

app.get('/api/me', (c) => respondMe(c, c.get('session')));

// Switch the active org: membership-validated (or staff), persisted as the user's
// default_organization_id, and echoed back as an updated me payload.
app.post('/api/org/switch', async (c) => {
  const session = c.get('session');
  const body = await readJsonBody(c, OrgSwitchRequestSchema);
  const { orgId } = body;

  const { isStaff, memberships } = session;
  if (!canEnterOrg(isStaff, memberships, orgId)) return forbidden(c);
  const { error } = await db(c.env).from('users')
    .update({ default_organization_id: orgId })
    .eq('id', session.appUserId);
  if (error) return internalError(c);

  // The next request re-resolves fully at the middleware.
  return respondMe(c, { ...session, activeOrgId: orgId, ...orgGrant(isStaff, memberships, orgId) });
});

app.post('/api/logout', (c) => {
  logActivity(c, 'logout');
  return c.body(null, HttpStatus.NoContent);
});

app.post('/api/activity', async (c) => {
  const body = await readJsonBody(c, ActivityRequestSchema);
  logActivity(c, body.activity_type);
  return c.body(null, HttpStatus.NoContent);
});

app.get('/api/dashboard', canRead, validQuery(DashboardQuery), async (c) => {
  const { period, role } = c.req.valid('query');
  if (role && !c.get('session').allowedViews.includes(role)) return forbidden(c);
  return kvOr404(c, role ? `dashboard:${period}:${role}` : `dashboard:${period}`, WORKER_ERR_NO_DATA, 'dashboard_view');
});

/** A row's numeric score for sorting; a row without one sorts as 0. */
function scoreOf(row: Record<string, unknown>): number {
  return typeof row.score === 'number' ? row.score : 0;
}

app.get('/api/metrics/:name/evaluations', canRead, validQuery(MetricEvaluationsQuery), requireMetricName, async (c) => {
  const { period, limit, offset, sortBy, scoreLabel } = c.req.valid('query');

  const data = await getSessionKv<{ rows: Array<Record<string, unknown>> }>(c, `metric:evaluations:${c.req.param('name')}:${period}`);
  if (!data) return c.json({ rows: [], total: 0, limit, offset, hasMore: false });

  let rows = data.rows;
  if (scoreLabel) rows = rows.filter((r: Record<string, unknown>) => r.label === scoreLabel);
  if (sortBy === 'score_asc') rows.sort((a, b) => scoreOf(a) - scoreOf(b));
  else if (sortBy === 'score_desc') rows.sort((a, b) => scoreOf(b) - scoreOf(a));

  const total = rows.length;
  const page = rows.slice(offset, offset + limit);
  return c.json({ rows: page, total, limit, offset, hasMore: offset + limit < total });
});

app.get('/api/metrics/:name', canRead, validQuery(WidePeriodQuery), requireMetricName, async (c) => {
  const name = c.req.param('name');
  return kvOr(c, `${METRIC_DETAIL_KEY_PREFIX}${name}:${c.req.valid('query').period}`, {
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
});

app.get('/api/trends/:name', canRead, validQuery(PeriodQuery), requireMetricName, async (c) => {
  const name = c.req.param('name');
  const { period } = c.req.valid('query');
  // `overallPercentiles` is undefined below the minimum sample, so JSON omits it, as the synced value does.
  const emptyTrend: TrendView = {
    metric: name, period, bucketCount: 0, totalEvaluations: 0, overallPercentiles: undefined, trendData: [], narrowed: false,
  };
  return kvOr(c, `${TREND_KEY_PREFIX}${name}:${period}`, emptyTrend);
});

app.get('/api/evaluations/trace/:traceId', canReadTraces, requireTraceId, async (c) =>
  kvOr(c, `evaluations:trace:${c.req.param('traceId')}`, { evaluations: [] }, 'trace_view'));

app.get('/api/traces/:traceId', canReadTraces, requireTraceId, async (c) => {
  const traceId = c.req.param('traceId');
  return kvOr404(c, `trace:${traceId}`, `No trace data for: ${traceId}`, 'trace_view');
});

app.get('/api/correlations', canRead, validQuery(WidePeriodQuery), async (c) =>
  kvOr(c, `correlations:${c.req.valid('query').period}`, { correlations: [], metrics: [] }));

app.get('/api/degradation-signals', canRead, validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  // Key matches DEGRADATION_KV_KEY in src/api/aggregates/kv-entry.ts + period suffix
  return kvOr(c, `meta/dashboard/degradation-signals:${period}`, { period, reports: [], computedAt: null });
});

app.get('/api/coverage', canRead, validQuery(CoverageQuery), async (c) => {
  const { period, inputKey } = c.req.valid('query');
  // The grid derives status and gaps from `counts`, so the empty matrix presents every field it reads.
  return kvOr(c, `coverage:${period}:${inputKey}`, {
    period, metrics: [], inputs: [], counts: [], coveredThreshold: 1, partialThreshold: 0, overallCoveragePercent: 0,
  });
});

app.get('/api/pipeline', requirePermission(PERMISSION.pipeline), validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  return kvOr(c, `pipeline:${period}`, { period, stages: [], totalEvaluations: 0 });
});

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function noSessionData(sessionId: string): string {
  return `No session data for: ${sessionId}`;
}

/** The synced session entry, or a 404. */
async function sessionEntry(c: AppContext, sessionId: string): Promise<Record<string, unknown>> {
  return await getSessionKv<Record<string, unknown>>(c, sessionKey(sessionId))
    ?? abort(c.json({ error: noSessionData(sessionId) }, HttpStatus.NotFound));
}

app.get('/api/sessions/:sessionId', requirePermission(PERMISSION.sessions), requireSessionId, async (c) => {
  const sessionId = c.req.param('sessionId');
  return kvOr404(c, sessionKey(sessionId), noSessionData(sessionId), 'session_view');
});

app.get('/api/agents', canReadAgents, validQuery(WidePeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  // The page requires `period` and `agents`; the dates are absent until a sync writes the key.
  return kvOr(c, `${AGENT_STATS_KEY_PREFIX}${period}`, { period, startDate: null, endDate: null, agents: [] });
});

app.get('/api/agents/detail/:agentId', canReadAgents, requireId('agentId', ERR_INVALID_AGENT_ID), async (c) => {
  const agentId = c.req.param('agentId');
  return kvOr404(c, `agent:${agentId}`, `No data for agent: ${agentId}`);
});

/** What the workflow view reads from a session entry; the agent view adds the evaluations. */
function workflowPayload(sessionId: string, session: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId,
    evaluation: session.multiAgentEvaluation ?? null,
    // Precomputed by the KV sync Workflow; absent on session keys written before it was added.
    graph: session.workflowGraph ?? null,
  };
}

app.get('/api/agents/:sessionId', canReadAgents, requireSessionId, async (c) => {
  const sessionId = c.req.param('sessionId');
  const session = await sessionEntry(c, sessionId);
  return c.json({
    ...workflowPayload(sessionId, session),
    spans: [],
    evaluations: safeArray(session.evaluations),
    agentMap: {},
  });
});

app.get('/api/agents/:sessionId/graph', canReadAgents, requireSessionId, async (c) => {
  const sessionId = c.req.param('sessionId');
  const session = await sessionEntry(c, sessionId);
  return c.json(workflowPayload(sessionId, session));
});

app.get('/api/compliance/sla', canReadCompliance, validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const dashboard = await getSessionKv<Record<string, unknown>>(c, `dashboard:${period}`);
  if (!dashboard) return c.json({ period, results: [], noSLAsConfigured: true });
  logActivity(c, 'compliance_view');
  const slaResults = safeArray(dashboard.slaCompliance);
  return c.json({
    period,
    results: slaResults,
    noSLAsConfigured: slaResults.length === 0,
  });
});

app.get('/api/compliance/verifications', canReadCompliance, validQuery(PeriodQuery), (c) => {
  const { period } = c.req.valid('query');
  logActivity(c, 'compliance_view');
  return c.json({ period, count: 0, verifications: [] });
});

/** The metric names a synced dashboard summary lists; the rest of the summary is not read here. */
const liveSummaryMetricsSchema = z.object({ metrics: z.array(z.object({ name: z.string().min(1) })) });

/** The fields of a synced `metric:evaluations:*` row the live view reads; rows are stored newest first. */
const liveEvaluationRowsSchema = z.object({
  rows: z.array(z.object({
    score: z.number(),
    unscored: z.literal(true).optional(),
    evaluatorType: z.string().nullish(),
    timestamp: z.union([z.string(), z.number()]),
    traceId: z.string().nullish(),
  })),
});

async function liveEvaluationsFor(c: AppContext, name: string): Promise<LiveEvaluation[]> {
  const raw = await getSessionKv<unknown>(c, `metric:evaluations:${name}:${QUALITY_LIVE_PERIOD}`);
  if (raw == null) return [];
  const parsed = liveEvaluationRowsSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`[/api/quality/live] ${name} rows failed schema validation:`, parsed.error.issues);
    return [];
  }
  return parsed.data.rows.map(({ unscored, score, ...row }) => ({ ...row, score: unscored ? null : score }));
}

app.get('/api/quality/live', canRead, async (c) => {
  const summary = liveSummaryMetricsSchema.safeParse(await getSessionKv<unknown>(c, `dashboard:${QUALITY_LIVE_PERIOD}`));
  const names = summary.success ? summary.data.metrics.map((m) => m.name) : [];
  const evaluationsByMetric = await Promise.all(
    names.map(async (name) => [name, await liveEvaluationsFor(c, name)] as const),
  );
  return c.json(summarizeQualityLive(evaluationsByMetric, new Date()));
});

app.get('/api/calibration', canRead, async (c) => {
  const raw = await getSessionKv<unknown>(c, 'meta:calibration');
  if (!raw) return c.json({ error: WORKER_ERR_NO_CALIBRATION_DATA }, HttpStatus.NotFound);
  // KV can hold a payload from an older derive publish; parsing surfaces the drift here
  // instead of in the frontend.
  return c.json(parsedOrAbort(c, calibrationResponseSchema, raw, ERR_CALIBRATION_MALFORMED));
});

app.get('/api/routing-telemetry', canRead, validQuery(PeriodQuery), async (c) => {
  const { period } = c.req.valid('query');
  const raw = await getSessionKv<unknown>(c, `routing-telemetry:${period}`);
  return c.json({ ...parsedOrAbort(c, routingTelemetryKvSchema, raw ?? {}, ERR_ROUTING_TELEMETRY_MALFORMED), period });
});

registerAdminRoutes(app);
registerJudgeConfigRoutes(app);

// SPA fallback: serve static assets / index.html for non-API routes
app.get('*', async (c) => {
  if (c.req.path === '/api' || c.req.path.startsWith('/api/')) return c.notFound();
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
