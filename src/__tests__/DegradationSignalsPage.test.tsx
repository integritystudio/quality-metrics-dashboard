/**
 * DegradationSignalsPage against the real query stack: `useDegradationSignals`
 * → `useApiQuery` → `apiFetch`, the real `PageShell` and a memory router. Only
 * `useAuth` and `fetch` are substituted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, cleanup, within } from '@testing-library/react';
import type { Period } from '../types.js';
import type { DegradationReport, DegradationSignalsResponse } from '../hooks/useDegradationSignals.js';
import { DegradationSignalsPage } from '../pages/DegradationSignalsPage.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import {
  PAGE_SHELL_ERROR_HEADING, PAGE_SHELL_SKELETON_SELECTOR, SERVER_ERROR_BODY, SERVER_ERROR_STATUS, apiErrorMessage,
  renderPage, stubPendingFetch,
} from './support/page-harness.js';
import { defined } from './support/defined.js';

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const PAGE_PATH = '/degradation-signals';
const DEFAULT_PERIOD: Period = '7d';
const EMPTY_HEADING = 'No Degradation Data';
const EWMA_DRIFT_COLUMN = 'EWMA Drift';
const CONFIRMED_COLUMN = 'Confirmed';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    period: DEFAULT_PERIOD,
    reports: [makeReport()],
    computedAt: '2026-03-27T00:00:00Z',
    ...overrides,
  };
}

function renderAtPeriod(period: Period = DEFAULT_PERIOD) {
  return renderPage(<DegradationSignalsPage period={period} />, PAGE_PATH);
}

/** Serve `body` from the API, render the page and wait for its table. */
async function renderLoaded(body: DegradationSignalsResponse = makeResponse(), period: Period = DEFAULT_PERIOD) {
  const fetchSpy = stubFetch(body);
  renderAtPeriod(period);
  await screen.findByRole('table');
  return fetchSpy;
}

/** The first report row's cell under the column headed `column`. */
function firstRowCell(column: string): HTMLElement {
  const index = screen.getAllByRole('columnheader').findIndex(header => header.textContent === column);
  const [, firstRow] = screen.getAllByRole('row');
  return defined(within(defined(firstRow)).getAllByRole('cell')[index]);
}

describe('DegradationSignalsPage — render', () => {
  it('renders table header columns when data is present', async () => {
    await renderLoaded();

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

  it('renders the loading skeleton and no table while the request is in flight', () => {
    stubPendingFetch();

    const { container } = renderAtPeriod();

    expect(container.querySelector(PAGE_SHELL_SKELETON_SELECTOR)).not.toBeNull();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the error state with the API message when the request fails', async () => {
    stubFetch(SERVER_ERROR_BODY, { status: SERVER_ERROR_STATUS });

    renderAtPeriod();

    expect(await screen.findByRole('heading', { name: PAGE_SHELL_ERROR_HEADING })).toBeInTheDocument();
    expect(screen.getByText(apiErrorMessage(SERVER_ERROR_STATUS, SERVER_ERROR_BODY))).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders empty state when data has no reports', async () => {
    stubFetch(makeResponse({ reports: [] }));

    renderAtPeriod();

    expect(await screen.findByText(EMPTY_HEADING)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('DegradationSignalsPage — signal display', () => {
  it('renders metric name in the row', async () => {
    await renderLoaded(makeResponse({ reports: [makeReport({ metricName: 'coherence' })] }));
    expect(screen.getByText('coherence')).toBeInTheDocument();
  });

  it('shows "Yes" with the p-value in EWMA Drift when the FDR correction upholds the drift', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: true, ewmaDriftPValue: 0.001, ewmaDriftFdrSignificant: true }) })],
    }));
    expect(firstRowCell(EWMA_DRIFT_COLUMN)).toHaveTextContent(/^Yes \(p=0\.0010\)$/);
  });

  it('marks a drift the family-level FDR correction overruled, with its p-value', async () => {
    // Raw detection stays visible; without the label the table would show a
    // drift beside a healthy status and explain nothing.
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: true, ewmaDriftPValue: 0.0435, ewmaDriftFdrSignificant: false }) })],
    }));
    expect(screen.getByText(/Not significant \(p=0\.0435\)/)).toBeInTheDocument();
  });

  it('renders a pre-FDR payload from KV, which carries neither field', async () => {
    // The pipeline overwrites these entries on its next run; until then the
    // page must not blow up on the fields it has not got.
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: true }) })],
    }));
    expect(firstRowCell(EWMA_DRIFT_COLUMN)).toHaveTextContent(/^Yes$/);
  });

  it('shows "No" in EWMA Drift column when ewmaDriftDetected is false', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: false, confirmed: true }) })],
    }));
    expect(firstRowCell(EWMA_DRIFT_COLUMN)).toHaveTextContent(/^No$/);
  });

  it('displays "Increasing" when varianceTrend is "increasing"', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'increasing' }) })],
    }));
    expect(screen.getByText('Increasing')).toBeInTheDocument();
  });

  it('displays "Stable" when varianceTrend is "stable"', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'stable' }) })],
    }));
    expect(screen.getByText('Stable')).toBeInTheDocument();
  });

  it('displays "Decreasing" when varianceTrend is "decreasing"', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceTrend: 'decreasing' }) })],
    }));
    expect(screen.getByText('Decreasing')).toBeInTheDocument();
  });

  it('displays consecutiveBreaches value as integer', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ consecutiveBreaches: 3 }) })],
    }));
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('displays varianceRatio formatted to 3 decimal places', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ varianceRatio: 1.5678 }) })],
    }));
    expect(screen.getByText('1.568')).toBeInTheDocument();
  });

  it('shows "Yes" in Confirmed column when confirmed is true', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ ewmaDriftDetected: false, confirmed: true }) })],
    }));
    expect(firstRowCell(CONFIRMED_COLUMN)).toHaveTextContent(/^Yes$/);
    expect(firstRowCell(EWMA_DRIFT_COLUMN)).toHaveTextContent(/^No$/);
  });

  it('displays coverageDropoutRate as percentage with 1 decimal place', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ coverageDropoutRate: 0.075 }) })],
    }));
    expect(screen.getByText('7.5%')).toBeInTheDocument();
  });

  it('displays latencySkewRatio formatted to 3 decimal places', async () => {
    await renderLoaded(makeResponse({
      reports: [makeReport({ signal: makeSignal({ latencySkewRatio: 2.3456 }) })],
    }));
    expect(screen.getByText('2.346')).toBeInTheDocument();
  });

  it('renders a row for each report', async () => {
    await renderLoaded(makeResponse({
      reports: [
        makeReport({ metricName: 'relevance' }),
        makeReport({ metricName: 'coherence' }),
        makeReport({ metricName: 'faithfulness' }),
      ],
    }));
    expect(screen.getByText('relevance')).toBeInTheDocument();
    expect(screen.getByText('coherence')).toBeInTheDocument();
    expect(screen.getByText('faithfulness')).toBeInTheDocument();
  });
});

describe('DegradationSignalsPage — computed at timestamp', () => {
  it('renders "Last computed" label when computedAt is present', async () => {
    await renderLoaded(makeResponse({ computedAt: '2026-03-27T12:00:00Z' }));
    expect(screen.getByText(/Last computed:/)).toBeInTheDocument();
  });

  it('does not render "Last computed" when computedAt is null', async () => {
    await renderLoaded(makeResponse({ computedAt: null }));
    expect(screen.queryByText(/Last computed:/)).not.toBeInTheDocument();
  });
});

describe('DegradationSignalsPage — request', () => {
  it.each<[Period, string]>([
    ['24h', '/api/degradation-signals?period=24h'],
    ['30d', '/api/degradation-signals?period=30d'],
  ])('requests the %s signals with the bearer token', async (period, expectedUrl) => {
    const fetchSpy = await renderLoaded(makeResponse({ period }), period);

    const [url, init] = defined(fetchSpy.mock.calls[0]);
    expect(url).toBe(expectedUrl);
    expect(headersOf(init).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });
});
