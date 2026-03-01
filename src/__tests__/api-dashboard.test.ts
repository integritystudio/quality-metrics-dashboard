/**
 * API route tests: /api/dashboard and /api/quality/live (Approach A — Node routes, mocked data-loader).
 *
 * Mock paths use 3 levels (../../../dist/) which the parentDistStub Vite plugin
 * resolves to the same virtual ID (\0dist/...) as the routes' 4-level imports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dist modules via their virtual IDs (parentDistStub intercepts both 3-level
// and 4-level relative dist imports into the same \0dist/... virtual module).
vi.mock('../../../dist/lib/quality-metrics.js', () => ({
  QUALITY_METRICS: {},
  computeDashboardSummary: vi.fn(),
  computeRoleView: vi.fn(),
}));

vi.mock('../../../dist/lib/quality-feature-engineering.js', () => ({
  computeCQI: vi.fn(),
}));

vi.mock('../../../dist/lib/error-sanitizer.js', () => ({
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
import { computeDashboardSummary, computeRoleView } from '../../../dist/lib/quality-metrics.js';
import { computeCQI } from '../../../dist/lib/quality-feature-engineering.js';
import { loadEvaluationsByMetric, checkHealth } from '../api/data-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockEval(name = 'relevance', score = 0.85, timestamp = '2026-01-15T12:00:00.000Z') {
  return {
    evaluationName: name,
    scoreValue: score,
    timestamp,
    traceId: 'trace-001',
    evaluatorType: 'seed',
    scoreLabel: 'relevant',
    explanation: 'Response is relevant.',
    evaluator: 'seed-evaluator',
  };
}

function makeMockDashboard() {
  return {
    overallStatus: 'healthy',
    metrics: [
      { name: 'relevance', status: 'healthy', currentValue: 0.85, threshold: 0.7, direction: 'above', alerts: [], trends: null },
    ],
    alerts: [],
    summary: { totalMetrics: 1, healthyMetrics: 1, warningMetrics: 0, criticalMetrics: 0, noDataMetrics: 0 },
    timestamp: '2026-01-15T12:00:00.000Z',
  };
}

// Clear all mocks between every test to prevent call-count accumulation
// across describe blocks (dashboard → health → quality/live).
beforeEach(vi.clearAllMocks);

// ---------------------------------------------------------------------------
// /dashboard route
// ---------------------------------------------------------------------------

describe('GET /dashboard', () => {
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([['relevance', [makeMockEval()]]]) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeDashboardSummary).mockReturnValue(makeMockDashboard() as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeCQI).mockReturnValue(0.82 as any);
  });

  it('rejects invalid period with 400', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=99d');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('rejects invalid role with 400', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d&role=superadmin');
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('error');
  });

  it('returns 200 with metrics, cqi, sparklines for valid period', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('cqi');
    expect(body).toHaveProperty('sparklines');
    expect(typeof body.cqi).toBe('number');
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
    const mockView = { ...makeMockDashboard(), role: 'executive' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeRoleView).mockReturnValue(mockView as any);

    const res = await dashboardRoutes.request('/dashboard?period=7d&role=executive');
    expect(res.status).toBe(200);
    expect(vi.mocked(computeRoleView)).toHaveBeenCalled();
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('cqi');
  });

  it('calls computeRoleView for operator role without cqi', async () => {
    const mockView = { ...makeMockDashboard(), role: 'operator' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(computeRoleView).mockReturnValue(mockView as any);

    const res = await dashboardRoutes.request('/dashboard?period=7d&role=operator');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // operator role does not include cqi at top level (only executive)
    expect(body).not.toHaveProperty('cqi');
  });

  it('returns sparklines as object keyed by metric name', async () => {
    const res = await dashboardRoutes.request('/dashboard?period=7d');
    const body = await res.json() as Record<string, unknown>;
    const sparklines = body.sparklines as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// /health route
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with status and hasData', async () => {
    vi.mocked(checkHealth).mockResolvedValue({ status: 'healthy', hasData: true });
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('hasData');
  });

  it('returns 500 when checkHealth throws', async () => {
    vi.mocked(checkHealth).mockRejectedValue(new Error('backend unavailable'));
    const res = await dashboardRoutes.request('/health');
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// /quality/live route
// ---------------------------------------------------------------------------

describe('GET /quality/live', () => {
  beforeEach(() => {
    const evals = [
      makeMockEval('relevance', 0.85, '2026-01-15T23:00:00.000Z'),
      makeMockEval('coherence', 0.9, '2026-01-15T22:00:00.000Z'),
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map([
      ['relevance', [evals[0]]],
      ['coherence', [evals[1]]],
    ]) as any);
  });

  it('returns 200 with metrics, sessionCount, lastUpdated', async () => {
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('sessionCount');
    expect(body).toHaveProperty('lastUpdated');
  });

  it('returns metrics sorted by name', async () => {
    const res = await qualityRoutes.request('/quality/live');
    const body = await res.json() as { metrics: { name: string }[] };
    const names = body.metrics.map(m => m.name);
    expect(names).toEqual([...names].sort());
  });

  it('each metric has name, score, evaluatorType, timestamp', async () => {
    const res = await qualityRoutes.request('/quality/live');
    const body = await res.json() as { metrics: Record<string, unknown>[] };
    for (const m of body.metrics) {
      expect(m).toHaveProperty('name');
      expect(m).toHaveProperty('score');
      expect(m).toHaveProperty('evaluatorType');
      expect(m).toHaveProperty('timestamp');
    }
  });

  it('handles empty evaluation map gracefully', async () => {
    vi.mocked(loadEvaluationsByMetric).mockResolvedValue(new Map() as any);
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(200);
    const body = await res.json() as { metrics: unknown[] };
    expect(body.metrics).toHaveLength(0);
  });

  it('returns 500 when data-loader throws', async () => {
    vi.mocked(loadEvaluationsByMetric).mockRejectedValue(new Error('no data'));
    const res = await qualityRoutes.request('/quality/live');
    expect(res.status).toBe(500);
  });
});
