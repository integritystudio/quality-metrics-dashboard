import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from '../components/Indicators.js';
import { HealthOverview } from '../components/HealthOverview.js';
import { AlertList } from '../components/AlertList.js';
import { SLATable } from '../components/SLATable.js';
import type {
  QualityDashboardSummary,
  TriggeredAlert,
  SLAComplianceResult,
  MetricTrend,
  ConfidenceIndicator,
} from '../types.js';

// ---------------------------------------------------------------------------
// Test Data Factories
// ---------------------------------------------------------------------------

function makeDashboard(overrides: Partial<QualityDashboardSummary> = {}): QualityDashboardSummary {
  return {
    overallStatus: 'healthy',
    metrics: [],
    alerts: [],
    summary: {
      totalMetrics: 7,
      healthyMetrics: 5,
      warningMetrics: 1,
      criticalMetrics: 1,
      noDataMetrics: 0,
    },
    timestamp: '2026-02-10T00:00:00Z',
    ...overrides,
  };
}

function makeAlert(overrides: Partial<TriggeredAlert> = {}): TriggeredAlert {
  return {
    severity: 'warning',
    message: 'Test alert message',
    aggregation: 'avg',
    threshold: 0.7,
    actualValue: 0.6,
    direction: 'below',
    ...overrides,
  };
}

function makeSLA(overrides: Partial<SLAComplianceResult> = {}): SLAComplianceResult {
  return {
    sla: { metric: 'relevance', aggregation: 'avg', target: 0.8, direction: 'above' },
    compliant: true,
    status: 'compliant',
    actualValue: 0.9,
    gap: 0.1,
    marginPercent: 12.5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// StatusBadge
// ---------------------------------------------------------------------------

describe('StatusBadge', () => {
  it('renders healthy status', () => {
    render(<StatusBadge status="healthy" />);
    expect(screen.getByLabelText('Status: healthy')).toBeInTheDocument();
    expect(screen.getByText(/healthy/)).toBeInTheDocument();
  });

  it('renders critical status', () => {
    render(<StatusBadge status="critical" />);
    expect(screen.getByLabelText('Status: critical')).toBeInTheDocument();
  });

  it('renders no_data status', () => {
    render(<StatusBadge status="no_data" />);
    expect(screen.getByLabelText('Status: no_data')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// TrendIndicator
// ---------------------------------------------------------------------------

describe('TrendIndicator', () => {
  it('renders nothing when trend is undefined', () => {
    const { container } = render(<TrendIndicator trend={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders improving trend with positive percentage', () => {
    const trend: MetricTrend = {
      direction: 'improving',
      delta: 0.05,
      percentChange: 5.3,
      currentValue: 0.85,
      previousValue: 0.8,
      aggregation: 'avg',
      lowSampleWarning: false,
    };
    render(<TrendIndicator trend={trend} />);
    expect(screen.getByText(/\+5.3%/)).toBeInTheDocument();
    expect(screen.getByLabelText(/improving/)).toBeInTheDocument();
  });

  it('renders degrading trend with negative percentage', () => {
    const trend: MetricTrend = {
      direction: 'degrading',
      delta: -0.05,
      percentChange: -3.1,
      currentValue: 0.75,
      previousValue: 0.8,
      aggregation: 'avg',
      lowSampleWarning: false,
    };
    render(<TrendIndicator trend={trend} />);
    expect(screen.getByText(/-3.1%/)).toBeInTheDocument();
  });

  it('shows low sample warning indicator', () => {
    const trend: MetricTrend = {
      direction: 'stable',
      delta: 0,
      percentChange: 0,
      currentValue: 0.8,
      previousValue: 0.8,
      aggregation: 'avg',
      lowSampleWarning: true,
    };
    render(<TrendIndicator trend={trend} />);
    expect(screen.getByText('*')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// ConfidenceBadge
// ---------------------------------------------------------------------------

describe('ConfidenceBadge', () => {
  it('renders nothing when confidence is undefined', () => {
    const { container } = render(<ConfidenceBadge confidence={undefined} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders high confidence', () => {
    const confidence: ConfidenceIndicator = {
      level: 'high',
      sampleCount: 100,
      scoreStdDev: 0.1,
      evaluatorCount: 1,
      evaluatorAgreement: null,
    };
    render(<ConfidenceBadge confidence={confidence} />);
    expect(screen.getByLabelText('Confidence: high')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// HealthOverview
// ---------------------------------------------------------------------------

describe('HealthOverview', () => {
  it('renders healthy banner text', () => {
    render(<HealthOverview dashboard={makeDashboard({ overallStatus: 'healthy' })} />);
    expect(screen.getByText('All metrics within thresholds')).toBeInTheDocument();
  });

  it('renders critical banner text', () => {
    render(<HealthOverview dashboard={makeDashboard({ overallStatus: 'critical' })} />);
    expect(screen.getByText('Critical issues detected')).toBeInTheDocument();
  });

  it('renders warning banner text', () => {
    render(<HealthOverview dashboard={makeDashboard({ overallStatus: 'warning' })} />);
    expect(screen.getByText('Some metrics need attention')).toBeInTheDocument();
  });

  it('renders no_data banner text', () => {
    render(<HealthOverview dashboard={makeDashboard({ overallStatus: 'no_data' })} />);
    expect(screen.getByText('No evaluation data available')).toBeInTheDocument();
  });

  it('renders summary counts', () => {
    const dash = makeDashboard({
      summary: { totalMetrics: 7, healthyMetrics: 3, warningMetrics: 2, criticalMetrics: 1, noDataMetrics: 1 },
    });
    const { container } = render(<HealthOverview dashboard={dash} />);
    const counts = container.querySelectorAll('.summary-count');
    expect(counts).toHaveLength(4);
    expect(within(counts[0] as HTMLElement).getByText('7')).toBeInTheDocument();
    expect(within(counts[0] as HTMLElement).getByText('Total')).toBeInTheDocument();
    expect(within(counts[1] as HTMLElement).getByText('3')).toBeInTheDocument();
    expect(within(counts[2] as HTMLElement).getByText('2')).toBeInTheDocument();
    expect(within(counts[3] as HTMLElement).getByText('1')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// AlertList
// ---------------------------------------------------------------------------

describe('AlertList', () => {
  it('renders nothing for empty alerts', () => {
    const { container } = render(<AlertList alerts={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders alert messages', () => {
    const alerts = [makeAlert({ message: 'Relevance p50 critically low' })];
    render(<AlertList alerts={alerts} />);
    expect(screen.getByText('Relevance p50 critically low')).toBeInTheDocument();
  });

  it('sorts alerts by severity (critical first)', () => {
    const alerts = [
      makeAlert({ severity: 'info', message: 'info alert' }),
      makeAlert({ severity: 'critical', message: 'critical alert' }),
      makeAlert({ severity: 'warning', message: 'warning alert' }),
    ];
    const { container } = render(<AlertList alerts={alerts} />);
    const items = container.querySelectorAll('.alert-item');
    expect(items[0]).toHaveTextContent('critical alert');
    expect(items[1]).toHaveTextContent('warning alert');
    expect(items[2]).toHaveTextContent('info alert');
  });

  it('renders remediation hints', () => {
    const alerts = [makeAlert({ remediationHints: ['Review recent prompt changes'] })];
    render(<AlertList alerts={alerts} />);
    expect(screen.getByText(/Review recent prompt changes/)).toBeInTheDocument();
  });

  it('renders aggregation and threshold metadata', () => {
    const alerts = [makeAlert({ aggregation: 'p50', actualValue: 0.45, threshold: 0.7 })];
    const { container } = render(<AlertList alerts={alerts} />);
    const meta = container.querySelector('.alert-meta');
    expect(meta).toHaveTextContent('p50 = 0.4500');
    expect(meta).toHaveTextContent('threshold: 0.7000');
  });
});

// ---------------------------------------------------------------------------
// SLATable
// ---------------------------------------------------------------------------

describe('SLATable', () => {
  it('renders nothing for empty SLAs', () => {
    const { container } = render(<SLATable slas={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders SLA rows with metric name and target', () => {
    const slas = [makeSLA()];
    render(<SLATable slas={slas} />);
    expect(screen.getByText('relevance (avg)')).toBeInTheDocument();
    expect(screen.getByText(/>= 0.8000/)).toBeInTheDocument();
  });

  it('renders actual value and gap', () => {
    const slas = [makeSLA({ actualValue: 0.9, gap: 0.1 })];
    const { container } = render(<SLATable slas={slas} />);
    const cells = container.querySelectorAll('td');
    // Cells: metric, target, actual, gap, status
    expect(cells[2]).toHaveTextContent('0.9000');
    expect(cells[3]).toHaveTextContent('+0.1000');
  });

  it('renders N/A for null actual value', () => {
    const slas = [makeSLA({ actualValue: null, gap: null, status: 'no_data', compliant: false })];
    render(<SLATable slas={slas} />);
    expect(screen.getByText('N/A')).toBeInTheDocument();
  });

  it('renders non-compliant gap in critical color', () => {
    const slas = [makeSLA({ compliant: false, gap: -0.1, status: 'non_compliant' })];
    render(<SLATable slas={slas} />);
    // Gap cell should have critical color style
    const gapCell = screen.getByText('-0.1000');
    expect(gapCell).toHaveStyle({ color: 'var(--status-critical)' });
  });
});
