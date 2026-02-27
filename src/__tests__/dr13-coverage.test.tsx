/**
 * DR13: Test coverage for TrendChart, TrendSeries, Sparkline, role views, API route validation.
 * Resolves backlog item DR13.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Sparkline } from '../components/Sparkline.js';
import { TrendChart } from '../components/TrendChart.js';
import { TrendSeries } from '../components/TrendSeries.js';
import { AuditorView } from '../components/views/AuditorView.js';
import { ExecutiveView } from '../components/views/ExecutiveView.js';
import { OperatorView } from '../components/views/OperatorView.js';
import type { MetricTrend, MetricDynamics } from '../types.js';
import type { TrendBucket } from '../hooks/useTrend.js';

// Note: ResizeObserver stub is installed globally in setup.ts

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrend(overrides: Partial<MetricTrend> = {}): MetricTrend {
  return {
    direction: 'improving',
    delta: 0.05,
    previousValue: 0.80,
    currentValue: 0.85,
    percentChange: 6.25,
    aggregation: 'avg',
    ...overrides,
  };
}

function makeDynamics(overrides: Partial<MetricDynamics> = {}): MetricDynamics {
  return {
    featureVersion: '1.0',
    velocity: 0.02,
    acceleration: 0.001,
    inflectionDetected: false,
    projectedStatus: 'healthy',
    confidence: 0.75,
    ...overrides,
  };
}

function makeTrendBucket(overrides: Partial<TrendBucket> = {}): TrendBucket {
  return {
    startTime: '2026-02-20T00:00:00Z',
    endTime: '2026-02-21T00:00:00Z',
    count: 5,
    avg: 0.82,
    percentiles: { p10: 0.7, p25: 0.77, p50: 0.82, p75: 0.88, p90: 0.93 },
    trend: null,
    dynamics: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

describe('Sparkline', () => {
  it('renders null for fewer than 2 valid data points', () => {
    const { container } = render(<Sparkline data={[0.5]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null for empty data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders null when all values are null', () => {
    const { container } = render(<Sparkline data={[null, null, null]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders SVG with polyline when 2+ valid values', () => {
    const { container } = render(<Sparkline data={[0.5, 0.7, 0.9]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    const polyline = container.querySelector('polyline');
    expect(polyline).not.toBeNull();
    const points = polyline!.getAttribute('points');
    expect(points).toBeTruthy();
    expect(points!.split(' ')).toHaveLength(3);
  });

  it('handles null gaps — excludes them from polyline points', () => {
    const { container } = render(<Sparkline data={[0.5, null, 0.9]} />);
    const polyline = container.querySelector('polyline');
    expect(polyline).not.toBeNull();
    // Only 2 valid values, so polyline has 2 points
    expect(polyline!.getAttribute('points')!.split(' ')).toHaveLength(2);
  });

  it('uses custom label as aria-label', () => {
    render(<Sparkline data={[0.5, 0.7]} label="relevance trend" />);
    expect(screen.getByLabelText('relevance trend')).toBeInTheDocument();
  });

  it('uses default aria-label when none provided', () => {
    render(<Sparkline data={[0.5, 0.7]} />);
    expect(screen.getByLabelText('Score trend sparkline')).toBeInTheDocument();
  });

  it('respects custom width and height', () => {
    const { container } = render(<Sparkline data={[0.5, 0.7]} width={120} height={40} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '120');
    expect(svg).toHaveAttribute('height', '40');
  });

  it('uses custom color on polyline stroke', () => {
    const { container } = render(<Sparkline data={[0.5, 0.7]} color="#ff0000" />);
    const polyline = container.querySelector('polyline');
    expect(polyline).toHaveAttribute('stroke', '#ff0000');
  });

  it('renders null when only 1 of multiple is finite', () => {
    const { container } = render(<Sparkline data={[NaN, Infinity, 0.5]} />);
    // Only 1 valid (0.5), renders null
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TrendChart
// ---------------------------------------------------------------------------

// Pinned epoch for all time-relative assertions in this describe block
const PINNED_NOW = new Date('2026-02-22T12:00:00.000Z');

describe('TrendChart', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders empty state when no trend provided', () => {
    render(<TrendChart metricName="relevance" />);
    expect(screen.getByText('No trend data available')).toBeInTheDocument();
  });

  it('renders chart container with aria-label when trend provided', () => {
    render(<TrendChart trend={makeTrend()} metricName="relevance" />);
    expect(screen.getByLabelText('Trend chart for relevance')).toBeInTheDocument();
  });

  it('shows projection data when dynamics.velocity is non-zero', () => {
    const trend = makeTrend();
    const dynamics = makeDynamics({ velocity: 0.05 });
    render(<TrendChart trend={trend} dynamics={dynamics} metricName="relevance" />);
    // velocity is shown in the dynamics section
    expect(screen.getByText('Velocity:')).toBeInTheDocument();
    expect(screen.getByText('Acceleration:')).toBeInTheDocument();
  });

  it('does not show dynamics section when dynamics is undefined', () => {
    render(<TrendChart trend={makeTrend()} metricName="relevance" />);
    expect(screen.queryByText('Velocity:')).toBeNull();
  });

  it('shows zero-velocity dynamics section without projection', () => {
    const dynamics = makeDynamics({ velocity: 0 });
    render(<TrendChart trend={makeTrend()} dynamics={dynamics} metricName="relevance" />);
    expect(screen.getByText('Velocity:')).toBeInTheDocument();
    // No "Breach in" when velocity is 0 and no projectedBreachTime
    expect(screen.queryByText('Breach in:')).toBeNull();
  });

  it('shows breach time when projectedBreachTime is provided', () => {
    // Project breach 25h from pinned now — renders as "25.0h"
    const futureIso = new Date(PINNED_NOW.getTime() + 25 * 60 * 60 * 1000).toISOString();
    const dynamics = makeDynamics({
      velocity: 0.05,
      projectedBreachTime: futureIso,
      projectedStatus: 'warning',
    });
    render(<TrendChart trend={makeTrend()} dynamics={dynamics} metricName="relevance" />);
    expect(screen.getByText('Breach in:')).toBeInTheDocument();
    expect(screen.getByText('25.0h')).toBeInTheDocument();
  });

  it('shows "threshold exceeded" for breach in the past', () => {
    const pastIso = new Date(PINNED_NOW.getTime() - 1 * 60 * 60 * 1000).toISOString();
    const dynamics = makeDynamics({
      velocity: 0.05,
      projectedBreachTime: pastIso,
      projectedStatus: 'critical',
    });
    render(<TrendChart trend={makeTrend()} dynamics={dynamics} metricName="relevance" />);
    expect(screen.getByText('threshold exceeded')).toBeInTheDocument();
  });

  it('shows breach in minutes for sub-1h breach', () => {
    // 30 minutes from pinned now → "30m"
    const futureIso = new Date(PINNED_NOW.getTime() + 30 * 60 * 1000).toISOString();
    const dynamics = makeDynamics({
      velocity: 0.05,
      projectedBreachTime: futureIso,
      projectedStatus: 'warning',
    });
    render(<TrendChart trend={makeTrend()} dynamics={dynamics} metricName="relevance" />);
    expect(screen.getByText('30m')).toBeInTheDocument();
  });

  it('shows breach in days for 2d+ breach', () => {
    // 3 days from pinned now → "3.0d"
    const futureIso = new Date(PINNED_NOW.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const dynamics = makeDynamics({
      velocity: 0.05,
      projectedBreachTime: futureIso,
      projectedStatus: 'warning',
    });
    render(<TrendChart trend={makeTrend()} dynamics={dynamics} metricName="relevance" />);
    expect(screen.getByText('3.0d')).toBeInTheDocument();
  });

  it('shows confidence percentage', () => {
    render(<TrendChart trend={makeTrend()} dynamics={makeDynamics({ confidence: 0.75 })} metricName="relevance" />);
    expect(screen.getByText('Confidence:')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });

  // Y-domain: when previousValue === currentValue, yPad falls back to 0.05 (TrendChart.tsx:86)
  // This must render the chart container, not the "Insufficient data" fallback
  it('renders chart (not empty state) when previous and current values are equal (flat trend)', () => {
    const flatTrend = makeTrend({ previousValue: 0.8, currentValue: 0.8, delta: 0 });
    render(<TrendChart trend={flatTrend} metricName="relevance" />);
    expect(screen.getByLabelText('Trend chart for relevance')).toBeInTheDocument();
    expect(screen.queryByText('No trend data available')).toBeNull();
    expect(screen.queryByText('Insufficient data')).toBeNull();
  });

  // Y-domain: chart handles threshold values in domain calculation
  it('renders without error when warningThreshold and criticalThreshold provided', () => {
    expect(() =>
      render(
        <TrendChart
          trend={makeTrend()}
          warningThreshold={0.7}
          criticalThreshold={0.5}
          metricName="relevance"
        />,
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TrendSeries
// ---------------------------------------------------------------------------

describe('TrendSeries', () => {
  it('renders empty state when data is empty array', () => {
    render(<TrendSeries data={[]} metricName="relevance" />);
    expect(screen.getByText('No trend data available')).toBeInTheDocument();
  });

  it('renders "no scored evaluations" when all avg values are null', () => {
    const buckets: TrendBucket[] = [
      makeTrendBucket({ avg: null, percentiles: null }),
      makeTrendBucket({ avg: null, percentiles: null }),
    ];
    render(<TrendSeries data={buckets} metricName="relevance" />);
    expect(screen.getByText('No scored evaluations in period')).toBeInTheDocument();
  });

  it('renders chart container when data has valid avg values', () => {
    const buckets: TrendBucket[] = [
      makeTrendBucket({ startTime: '2026-02-20T00:00:00Z', endTime: '2026-02-21T00:00:00Z', avg: 0.82 }),
      makeTrendBucket({ startTime: '2026-02-21T00:00:00Z', endTime: '2026-02-22T00:00:00Z', avg: 0.85 }),
    ];
    render(<TrendSeries data={buckets} metricName="relevance" />);
    expect(screen.getByLabelText('Time series trend for relevance')).toBeInTheDocument();
  });

  it('renders legend row with avg, p50, p10-p90 labels', () => {
    const buckets: TrendBucket[] = [
      makeTrendBucket({ avg: 0.82 }),
      makeTrendBucket({ avg: 0.85 }),
    ];
    const { container } = render(<TrendSeries data={buckets} metricName="relevance" />);
    expect(container.textContent).toContain('avg');
    expect(container.textContent).toContain('p50');
    expect(container.textContent).toContain('p10-p90');
  });

  it('handles single-day span without error', () => {
    const now = new Date('2026-02-22T12:00:00Z');
    const buckets: TrendBucket[] = [
      makeTrendBucket({
        startTime: new Date(now.getTime() - 12 * 3600000).toISOString(),
        endTime: now.toISOString(),
        avg: 0.82,
      }),
      makeTrendBucket({
        startTime: now.toISOString(),
        endTime: new Date(now.getTime() + 12 * 3600000).toISOString(),
        avg: 0.84,
      }),
    ];
    expect(() => render(<TrendSeries data={buckets} metricName="relevance" />)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Role Views
// ---------------------------------------------------------------------------

function makeMetricResult(name: string, displayName: string, status: 'healthy' | 'warning' | 'critical' | 'no_data' = 'healthy') {
  return {
    name,
    displayName,
    status,
    sampleCount: 10,
    values: { avg: 0.88, min: 0.70, max: 0.95, count: 10, p50: 0.88, p95: 0.93, p99: 0.95 },
    alerts: [] as Array<{ severity: 'warning' | 'critical'; message: string; aggregation: 'avg'; threshold: number; actualValue: number; direction: 'below' | 'above' }>,
  };
}

describe('AuditorView', () => {
  function makeAuditorData() {
    return {
      role: 'auditor' as const,
      totalEvaluationCount: 150,
      metrics: [makeMetricResult('relevance', 'Relevance')],
      alerts: [
        { severity: 'warning' as const, message: 'Relevance degrading', aggregation: 'avg' as const,
          threshold: 0.8, actualValue: 0.79, direction: 'below' as const, metricName: 'relevance' },
      ],
      timestamp: '2026-02-22T12:00:00Z',
      slaCompliance: [],
    };
  }

  it('renders total evaluation count', () => {
    const { container } = render(<AuditorView data={makeAuditorData()} />);
    // The 150 count appears in the first stats card
    const countCards = container.querySelectorAll('.card');
    const texts = Array.from(countCards).map(el => el.textContent);
    expect(texts.some(t => t?.includes('150'))).toBe(true);
  });

  it('renders metrics count as 1', () => {
    const { container } = render(<AuditorView data={makeAuditorData()} />);
    // stats cards: 150 (total), 1 (metrics), 1 (alerts)
    const cardTexts = Array.from(container.querySelectorAll('.card')).map(el => el.textContent);
    // At least one card shows "1" and "Metrics"
    expect(cardTexts.some(t => t?.includes('Metrics') && t?.includes('1'))).toBe(true);
  });

  it('shows All Metrics section', () => {
    render(<AuditorView data={makeAuditorData()} />);
    expect(screen.getByText('All Metrics')).toBeInTheDocument();
  });

  it('shows All Alerts section when alerts present', () => {
    render(<AuditorView data={makeAuditorData()} />);
    expect(screen.getByText('All Alerts')).toBeInTheDocument();
  });

  it('does not show alerts section when no alerts', () => {
    const data = { ...makeAuditorData(), alerts: [] };
    render(<AuditorView data={data} />);
    expect(screen.queryByText('All Alerts')).toBeNull();
  });

  it('renders computed-at timestamp', () => {
    render(<AuditorView data={makeAuditorData()} />);
    expect(screen.getByText('Computed At')).toBeInTheDocument();
  });
});

describe('ExecutiveView', () => {
  function makeExecutiveData() {
    return {
      role: 'executive' as const,
      overallStatus: 'healthy' as const,
      summary: { totalMetrics: 7, healthyMetrics: 6, warningMetrics: 1, criticalMetrics: 0, noDataMetrics: 0 },
      topIssues: [
        { name: 'hallucination', displayName: 'Hallucination Rate', status: 'warning', alertCount: 2 },
      ],
      metricStatuses: [
        { name: 'relevance', displayName: 'Relevance', status: 'healthy' },
        { name: 'hallucination', displayName: 'Hallucination Rate', status: 'warning' },
      ],
      alertCounts: { warning: 1, critical: 0, info: 0 },
    };
  }

  it('renders Executive Summary header', () => {
    render(<ExecutiveView data={makeExecutiveData()} />);
    expect(screen.getByText('Executive Summary')).toBeInTheDocument();
  });

  it('renders top issues when present', () => {
    render(<ExecutiveView data={makeExecutiveData()} />);
    expect(screen.getByText('Top Issues')).toBeInTheDocument();
    // "Hallucination Rate" appears in both top issues and metric statuses
    expect(screen.getAllByText('Hallucination Rate').length).toBeGreaterThanOrEqual(1);
  });

  it('renders metric statuses', () => {
    render(<ExecutiveView data={makeExecutiveData()} />);
    expect(screen.getByText('Metric Statuses')).toBeInTheDocument();
    expect(screen.getByText('Relevance')).toBeInTheDocument();
  });

  it('renders alert summary counts', () => {
    render(<ExecutiveView data={makeExecutiveData()} />);
    expect(screen.getByText('Alert Summary')).toBeInTheDocument();
  });

  it('renders SLA counts when provided', () => {
    const data = { ...makeExecutiveData(), slaCompliantCount: 3, slaTotalCount: 4 };
    render(<ExecutiveView data={data} />);
    expect(screen.getByText('3/4')).toBeInTheDocument();
    expect(screen.getByText('SLAs Met')).toBeInTheDocument();
  });

  it('shows plural alerts in top issues', () => {
    render(<ExecutiveView data={makeExecutiveData()} />);
    expect(screen.getByText(/2 alerts/)).toBeInTheDocument();
  });

  it('shows singular alert in top issues', () => {
    const data = {
      ...makeExecutiveData(),
      topIssues: [{ name: 'relevance', displayName: 'Relevance', status: 'warning', alertCount: 1 }],
    };
    render(<ExecutiveView data={data} />);
    // "1 alert" (no 's')
    const listItems = screen.getAllByRole('listitem');
    expect(listItems.some(li => li.textContent?.includes('1 alert') && !li.textContent?.includes('alerts'))).toBe(true);
  });
});

describe('OperatorView', () => {
  function makeTrendForOperator(): MetricTrend {
    return { direction: 'degrading', delta: -0.05, previousValue: 0.85, currentValue: 0.80, percentChange: -5.88, aggregation: 'avg' };
  }

  function makeOperatorData() {
    return {
      role: 'operator' as const,
      overallStatus: 'warning' as const,
      prioritizedAlerts: [
        { severity: 'warning' as const, message: 'Relevance below threshold', aggregation: 'avg' as const,
          threshold: 0.8, actualValue: 0.75, direction: 'below' as const, metricName: 'relevance' },
      ],
      degradingTrends: [
        { metricName: 'relevance', trend: makeTrendForOperator() },
      ],
      alertingMetrics: [],
    };
  }

  it('renders "All Clear" when no alerts and no degrading trends', () => {
    const data = { ...makeOperatorData(), prioritizedAlerts: [], degradingTrends: [] };
    render(<OperatorView data={data} />);
    expect(screen.getByText('All Clear')).toBeInTheDocument();
    expect(screen.getByText('No active alerts or degrading trends.')).toBeInTheDocument();
  });

  it('renders prioritized alerts when present', () => {
    render(<OperatorView data={makeOperatorData()} />);
    expect(screen.getByText('Prioritized Alerts')).toBeInTheDocument();
    expect(screen.getByText('Relevance below threshold')).toBeInTheDocument();
  });

  it('renders degrading trends section when present', () => {
    render(<OperatorView data={makeOperatorData()} />);
    expect(screen.getByText('Degrading Trends')).toBeInTheDocument();
    expect(screen.getByText(/relevance/)).toBeInTheDocument();
  });

  it('renders alert count in header banner', () => {
    render(<OperatorView data={makeOperatorData()} />);
    expect(screen.getByText(/1 active alert/)).toBeInTheDocument();
  });

  it('renders plural in banner for multiple alerts', () => {
    const data = {
      ...makeOperatorData(),
      prioritizedAlerts: [
        { severity: 'warning' as const, message: 'Alert 1', aggregation: 'avg' as const, threshold: 0.8, actualValue: 0.75, direction: 'below' as const, metricName: 'relevance' },
        { severity: 'critical' as const, message: 'Alert 2', aggregation: 'avg' as const, threshold: 0.5, actualValue: 0.3, direction: 'below' as const, metricName: 'faithfulness' },
      ],
    };
    render(<OperatorView data={data} />);
    expect(screen.getByText(/2 active alerts/)).toBeInTheDocument();
  });

  it('does not show All Clear when only degrading trends present', () => {
    const data = { ...makeOperatorData(), prioritizedAlerts: [] };
    render(<OperatorView data={data} />);
    expect(screen.queryByText('All Clear')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Trends API route — input validation
// ---------------------------------------------------------------------------

vi.mock('../../../../dist/lib/quality-metrics.js', () => ({
  getQualityMetric: vi.fn((name: string) => name === 'relevance' ? { aggregations: ['avg'] } : null),
  computeMetricDetail: vi.fn(() => null),
  computeAggregations: vi.fn(() => ({})),
  QUALITY_METRICS: { relevance: { aggregations: ['avg'] } },
}));

vi.mock('../../../../dist/lib/quality-feature-engineering.js', () => ({
  computePercentileDistribution: vi.fn(() => null),
  computeMetricDynamics: vi.fn(() => null),
}));

vi.mock('../../../../dist/lib/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: vi.fn((e: unknown) => String(e)),
}));

vi.mock('../api/data-loader.js', async () => ({
  loadEvaluationsForMetric: vi.fn(async () => []),
}));

describe('trends API route validation', () => {
  // ESM caches the module — trendRoutes is a singleton across all loadTrendRoutes() calls.
  // Reset mock call counts after each test; implementations are preserved by vi.clearAllMocks().
  afterEach(() => {
    vi.clearAllMocks();
  });

  async function loadTrendRoutes() {
    const { trendRoutes } = await import('../api/routes/trends.js');
    return trendRoutes;
  }

  it('returns 404 for unknown metric', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/nonexistent-metric');
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('nonexistent-metric');
  });

  it('returns 400 for invalid period param', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance?period=invalid');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid period');
  });

  it('returns 400 for invalid buckets param (non-integer)', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance?period=7d&buckets=abc');
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('Invalid buckets');
  });

  it('returns 400 for buckets below minimum (< 3)', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance?period=7d&buckets=2');
    expect(res.status).toBe(400);
  });

  it('returns 400 for buckets above maximum (> 30)', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance?period=7d&buckets=31');
    expect(res.status).toBe(400);
  });

  it('returns 200 for valid known metric and default params', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance');
    expect(res.status).toBe(200);
    const body = await res.json() as { metric: string };
    expect(body.metric).toBe('relevance');
  });

  it('returns 200 for valid period and buckets', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends/relevance?period=24h&buckets=5');
    expect(res.status).toBe(200);
  });

  it('returns 400 for invalid period on /trends summary route', async () => {
    const app = await loadTrendRoutes();
    const res = await app.request('/trends?period=invalid');
    expect(res.status).toBe(400);
  });
});
