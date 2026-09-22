/**
 * API route tests: /api/dashboard and /api/quality/live.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run;
 * pure computation functions (computeDashboardSummary, computeRoleView, computeCQI)
 * stay mocked because they receive EvaluationResult arrays, not HTTP payloads.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

vi.mock('../api/parent/quality-metrics.js', () => ({
  QUALITY_METRICS: {},
  computeDashboardSummary: vi.fn(),
}));

vi.mock('../api/parent/quality-views.js', () => ({
  computeRoleView: vi.fn(),
}));

vi.mock('../api/parent/qfe-cqi.js', () => ({
  computeCQI: vi.fn(),
}));

import { dashboardRoutes } from '../api/routes/dashboard.js';
import { qualityRoutes } from '../api/routes/quality.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import { computeRoleView } from '../api/parent/quality-views.js';
import { computeCQI } from '../api/parent/qfe-cqi.js';
import type {
  DashboardResponse,
  ErrorResponse,
  HealthResponse,
  QualityLiveResponse,
  RoleViewResponse,
} from './support/api-responses.js';
import {
  EVAL_NANOS,
  makeCQI,
  makeDashboardSummary,
  makeEvaluation,
  makeExecutiveView,
  makeOperatorView,
} from './support/fixtures.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

function makeMockEval(name = 'relevance', score = 0.85, timestamp = EVAL_NANOS) {
  return makeEvaluation({ evaluationName: name, scoreValue: score, timestamp });
}

// Clear all mocks between every test
beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

// /dashboard route

describe('GET /dashboard', () => {
  beforeEach(() => {
    fixture.setEvals([evalToWire(makeMockEval())]);
    vi.mocked(computeDashboardSummary).mockReturnValue(makeDashboardSummary());
    vi.mocked(computeCQI).mockReturnValue(makeCQI());
  });

  it('rejects invalid period with 400', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=99d');
    expect(res.status).toBe(400);
    const body = await res.json() as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('rejects invalid role with 400', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d&role=superadmin');
    expect(res.status).toBe(400);
    const body = await res.json() as ErrorResponse;
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with metrics, cqi, sparklines for valid period', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as DashboardResponse;
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('cqi');
    expect(body).toHaveProperty('sparklines');
    expect(body.cqi?.value).toBeCloseTo(0.82, 3);
    expect(body.cqi).toHaveProperty('contributions');
  });

  it('accepts 24h period', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=24h');
    expect(res.status).toBe(200);
  });

  it('accepts 30d period', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=30d');
    expect(res.status).toBe(200);
  });

  it('calls computeRoleView for executive role and includes cqi', async () => {
    vi.mocked(computeRoleView).mockReturnValue(makeExecutiveView());

    const res = await dashboardRoutes.request('/dashboard?period=7d&role=executive');
    expect(res.status).toBe(200);
    expect(vi.mocked(computeRoleView)).toHaveBeenCalled();
    const body = await res.json() as RoleViewResponse;
    expect(body).toHaveProperty('cqi');
  });

  it('calls computeRoleView for operator role without cqi', async () => {
    vi.mocked(computeRoleView).mockReturnValue(makeOperatorView());

    const res = await dashboardRoutes.request('/dashboard?period=7d&role=operator');
    expect(res.status).toBe(200);
    const body = await res.json() as RoleViewResponse;
    expect(body).not.toHaveProperty('cqi');
  });

  it('returns sparklines as object keyed by metric name', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    const body = await res.json() as DashboardResponse;
    const sparklines = body.sparklines;
    expect(typeof sparklines).toBe('object');
    // sparklines keys come from the evaluation Map returned by loadEvaluationsByMetric;
    // the fixture serves a 'relevance' evaluation so 'relevance' is a key.
    expect(sparklines).toHaveProperty('relevance');
    const vals = sparklines['relevance'] as (number | null)[];
    expect(Array.isArray(vals)).toBe(true);
    expect(vals.length).toBeGreaterThan(0);
    expect(vals.every(v => v === null || typeof v === 'number')).toBe(true);
  });

  it('returns 500 when data-loader throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    expect(res.status).toBe(500);
  });
});

// /health route

describe('GET /health', () => {
  it('returns 200 with status and hasData', async () => {
    // fixture /health returns { status: 'ok' }, /v1/evaluations returns []
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as HealthResponse;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('hasData');
  });

  it('returns 500 when the evaluations query throws', async () => {
    // healthCheck() catches errors from be.healthCheck() internally (returns
    // error status instead of throwing). be.queryEvaluations() is NOT caught
    // by healthCheck(), so failing /v1/evaluations propagates to the route.
    fixture.failPath('/v1/evaluations');
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(500);
  });
});

// /quality/live route

describe('GET /quality/live', () => {
  const ONE_HOUR_NANOS = 3_600_000_000_000n;

  beforeEach(() => {
    fixture.setEvals([
      evalToWire(makeMockEval('relevance', 0.85, EVAL_NANOS + ONE_HOUR_NANOS), 1),
      evalToWire(makeMockEval('coherence', 0.9, EVAL_NANOS), 2),
    ]);
  });

  it('returns 200 with metrics, sessionCount, lastUpdated', async () => {
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(200);
    const body = await res.json() as QualityLiveResponse;
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('sessionCount');
    expect(body).toHaveProperty('lastUpdated');
  });

  it('returns metrics sorted by name', async () => {
    const res = await qualityRoutes.request('/quality/live');
    const body = await res.json() as QualityLiveResponse;
    const names = body.metrics.map((m) => m.name);
    expect(names).toEqual([...names].sort());
  });

  it('each metric has name, score, evaluatorType, timestamp', async () => {
    const res = await qualityRoutes.request('/quality/live');
    const body = await res.json() as QualityLiveResponse;
    for (const m of body.metrics) {
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('score');
      expect(m).toHaveProperty('evaluatorType');
      expect(m).toHaveProperty('timestamp');
    }
  });

  it('handles empty evaluation map gracefully', async () => {
    fixture.reset(); // empty evals
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(200);
    const body = await res.json() as QualityLiveResponse;
    expect(body.metrics).toHaveLength(0);
  });

  it('returns 500 when data-loader throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(500);
  });
});
