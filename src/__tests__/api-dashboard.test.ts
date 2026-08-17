/**
 * API route tests: /api/dashboard and /api/quality/live (Approach A — Node routes, mocked data-loader).
 *
 * Parent code is mocked at the src/api/parent/ boundary modules — the only
 * sanctioned import path for parent runtime code (see CLAUDE.md § Parent boundary).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../api/parent/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: (err: unknown) => String(err),
}));

// Mock data-loader with explicit factory to avoid auto-mock resolution issues
vi.mock('../api/data-loader.js', () => ({
  loadEvaluationsByMetric: vi.fn(),
  loadEvaluationsForMetric: vi.fn(),
  loadEvaluationsByTraceId: vi.fn(),
  loadEvaluationsByTraceIds: vi.fn(),
  loadTracesByTraceId: vi.fn(),
  loadTracesBySessionId: vi.fn(),
  loadLogsByTraceId: vi.fn(),
  loadLogsBySessionId: vi.fn(),
  loadVerifications: vi.fn(),
  loadEvaluationsBySessionId: vi.fn(),
  checkHealth: vi.fn(),
}));

import { dashboardRoutes } from '../api/routes/dashboard.js';
import { qualityRoutes } from '../api/routes/quality.js';
import { computeDashboardSummary } from '../api/parent/quality-metrics.js';
import { computeRoleView } from '../api/parent/quality-views.js';
import { computeCQI } from '../api/parent/qfe-cqi.js';
import { loadEvaluationsByMetric, checkHealth } from '../api/data-loader.js';
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


function makeMockEval(name = 'relevance', score = 0.85, timestamp = EVAL_NANOS) {
  return makeEvaluation({ evaluationName: name, scoreValue: score, timestamp });
}

// Clear all mocks between every test to prevent call-count accumulation
// across describe blocks (dashboard → health → quality/live).
beforeEach(vi.clearAllMocks);

// /dashboard route

describe('GET /dashboard', () => {
  beforeEach(() => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([['relevance', [makeMockEval()]]]));
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
    // `computeCQI` returns a `CompositeQualityIndex` object and the route passes
    // it through untouched. This asserted `typeof body.cqi === 'number'`, which
    // only held because the mock returned a bare `0.82`.
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
    // operator role does not include cqi at top level (only executive)
    expect(body).not.toHaveProperty('cqi');
  });

  it('returns sparklines as object keyed by metric name', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    const body = await res.json() as DashboardResponse;
    const sparklines = body.sparklines;
    expect(typeof sparklines).toBe('object');
    expect(sparklines).toHaveProperty('relevance');
    const vals = sparklines['relevance'] as (number | null)[];
    expect(Array.isArray(vals)).toBe(true);
    expect(vals.length).toBeGreaterThan(0);
    expect(vals.every(v => v === null || typeof v === 'number')).toBe(true);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('disk read failed'));
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    expect(res.status).toBe(500);
  });
});

// /health route

describe('GET /health', () => {
  it('returns 200 with status and hasData', async () => {
    vi.mocked(checkHealth).mockResolvedValue({ status: 'healthy', hasData: true });
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as HealthResponse;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('hasData');
  });

  it('returns 500 when checkHealth throws', async () => {
    vi.mocked(checkHealth).mockRejectedValue(new Error('backend unavailable'));
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(500);
  });
});

// /quality/live route

describe('GET /quality/live', () => {
  beforeEach(() => {
    const ONE_HOUR_NANOS = 3_600_000_000_000n;
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([
      ['relevance', [makeMockEval('relevance', 0.85, EVAL_NANOS + ONE_HOUR_NANOS)]],
      ['coherence', [makeMockEval('coherence', 0.9, EVAL_NANOS)]],
    ]));
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
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map());
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(200);
    const body = await res.json() as QualityLiveResponse;
    expect(body.metrics).toHaveLength(0);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('no data'));
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(500);
  });
});
