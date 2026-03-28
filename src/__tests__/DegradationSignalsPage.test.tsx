import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PageShellProps } from './test-types.js';
import type { DegradationReport, DegradationSignalsResponse } from '../hooks/useDegradationSignals.js';

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

vi.mock('../hooks/useDegradationSignals.js', () => ({
  useDegradationSignals: vi.fn(),
}));

vi.mock('../components/PageShell.js', () => ({
  PageShell: ({ isLoading, error, children }: PageShellProps) => {
    if (isLoading) return <div data-testid="page-shell-loading" />;
    if (error) return <div data-testid="page-shell-error">{error.message}</div>;
    return <div data-testid="page-shell">{children}</div>;
  },
}));


import { useDegradationSignals } from '../hooks/useDegradationSignals.js';
import { DegradationSignalsPage } from '../pages/DegradationSignalsPage.js';

const mockUseDegradationSignals = vi.mocked(useDegradationSignals);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeSignal(overrides: Partial<DegradationReport['signal']> = {}): DegradationReport['signal'] {
  return {
    featureVersion: '1.0.0',
    varianceTrend: 'stable',
    varianceRatio: 1.234,
    coverageDropoutRate: 0.05,
    latencySkewRatio: 1.567,
    predictedStatus: 'healthy',
    ewmaDriftDetected: false,
    consecutiveBreaches: 0,
    confirmed: false,
    ...overrides,
  };
}

function makeReport(overrides: Partial<DegradationReport> = {}): DegradationReport {
  return {
    metricName: 'relevance',
    signal: makeSignal(),
    ...overrides,
  };
}

function makeResponse(overrides: Partial<DegradationSignalsResponse> = {}): DegradationSignalsResponse {
  return {
    period: '7d',
    reports: [makeReport()],
    computedAt: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

type MockQueryResult = { data: DegradationSignalsResponse | undefined; isLoading: boolean; error: Error | null };

function mockQuery(result: MockQueryResult) {
  mockUseDegradationSignals.mockReturnValue(result as unknown as ReturnType<typeof useDegradationSignals>);
}

function mockLoaded(data: DegradationSignalsResponse | undefined = makeResponse()) {
  mockQuery({ data, isLoading: false, error: null });
}


describe('DegradationSignalsPage — render', () => {
  it('renders table header columns when data is present', () => {
    mockLoaded();
    render(<DegradationSignalsPage period="7d" />);

    expect(screen.getByRole('columnheader', { name: 'Metric' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'EWMA Drift' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Variance Trend' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Variance Ratio' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Consecutive Breaches' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Confirmed' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Coverage Dropout' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Latency Skew' })).toBeInTheDocument();
  }, TEST_TIMEOUT_MS);

  it('renders loading state when isLoading is true', () => {
    mockQuery({ data: undefined, isLoading: true, error: null });
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByTestId('page-shell-loading')).toBeInTheDocument();
  });

  it('renders error state when error is present', () => {
    mockQuery({ data: undefined, isLoading: false, error: new Error('Network failure') });
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByTestId('page-shell-error')).toBeInTheDocument();
    expect(screen.getByText('Network failure')).toBeInTheDocument();
  });

  it('renders empty state when data has no reports', () => {
    mockLoaded(makeResponse({ reports: [] }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('No Degradation Data')).toBeInTheDocument();
  });

  it('renders nothing (no table) when data is undefined', () => {
    mockQuery({ data: undefined, isLoading: false, error: null });
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});


describe('DegradationSignalsPage — signal display', () => {
  it('renders metric name in the row', () => {
    mockLoaded(makeResponse({ reports: [makeReport({ metricName: 'coherence' })] }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('coherence')).toBeInTheDocument();
  });

  it('shows "Yes" in EWMA Drift column when ewmaDriftDetected is true', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: true }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('shows "No" in EWMA Drift column when ewmaDriftDetected is false', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: false, confirmed: false }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    const noCells = screen.getAllByText('No');
    expect(noCells.length).toBeGreaterThanOrEqual(1);
  });

  it('displays "Increasing" when varianceTrend is "increasing"', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'increasing' }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('Increasing')).toBeInTheDocument();
  });

  it('displays "Stable" when varianceTrend is "stable"', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'stable' }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('Stable')).toBeInTheDocument();
  });

  it('displays "Decreasing" when varianceTrend is "decreasing"', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'decreasing' }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('Decreasing')).toBeInTheDocument();
  });

  it('displays consecutiveBreaches value as integer', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ consecutiveBreaches: 3 }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('displays varianceRatio formatted to 3 decimal places', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceRatio: 1.5678 }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('1.568')).toBeInTheDocument();
  });

  it('shows "Yes" in Confirmed column when confirmed is true', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: false, confirmed: true }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('displays coverageDropoutRate as percentage with 1 decimal place', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ coverageDropoutRate: 0.075 }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('7.5%')).toBeInTheDocument();
  });

  it('displays latencySkewRatio formatted to 3 decimal places', () => {
    mockLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ latencySkewRatio: 2.3456 }) })],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('2.346')).toBeInTheDocument();
  });

  it('renders a row for each report', () => {
    mockLoaded(makeResponse({
      reports: [
        makeReport({ metricName: 'relevance' }),
        makeReport({ metricName: 'coherence' }),
        makeReport({ metricName: 'faithfulness' }),
      ],
    }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText('relevance')).toBeInTheDocument();
    expect(screen.getByText('coherence')).toBeInTheDocument();
    expect(screen.getByText('faithfulness')).toBeInTheDocument();
  });
});


describe('DegradationSignalsPage — computed at timestamp', () => {
  it('renders "Last computed" label when computedAt is present', () => {
    mockLoaded(makeResponse({ computedAt: '2026-03-27T12:00:00Z' }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.getByText(/Last computed:/)).toBeInTheDocument();
  });

  it('does not render "Last computed" when computedAt is null', () => {
    mockLoaded(makeResponse({ computedAt: null }));
    render(<DegradationSignalsPage period="7d" />);
    expect(screen.queryByText(/Last computed:/)).not.toBeInTheDocument();
  });
});


describe('DegradationSignalsPage — hook invocation', () => {
  it('calls useDegradationSignals with the provided period', () => {
    mockLoaded();
    render(<DegradationSignalsPage period="24h" />);
    expect(mockUseDegradationSignals).toHaveBeenCalledWith('24h');
  });

  it('calls useDegradationSignals with period "30d"', () => {
    mockLoaded(makeResponse({ period: '30d' }));
    render(<DegradationSignalsPage period="30d" />);
    expect(mockUseDegradationSignals).toHaveBeenCalledWith('30d');
  });
});
