import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TEST_ACCESS_TOKEN, makeQueryWrapper, stubFetch } from './support/query-harness.js';
import { SERVER_ERROR_BODY, SERVER_ERROR_STATUS } from './support/page-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN), signOut: () => Promise.resolve() }),
}));

import { Layout } from '../components/Layout.js';
import { KeyboardNavProvider } from '../contexts/KeyboardNavContext.js';
import { DATA_GATED_PERIOD, type Period } from '../lib/constants.js';
import { HttpStatus } from '../lib/http-constants.js';
import { WORKER_ERR_NO_DATA } from '../lib/worker-contract.js';

const GATED_PERIOD_KEY = '4';
const SELECTED_PERIOD: Period = '7d';
const SUMMARY_WITH_DATA = {
  overallStatus: 'healthy',
  metrics: [],
  alerts: [],
  summary: { totalMetrics: 0, healthyMetrics: 0, warningMetrics: 0, criticalMetrics: 0, noDataMetrics: 0 },
  timestamp: '2026-10-18T00:00:00.000Z',
};

function renderLayout(period: Period, onPeriodChange: (p: Period) => void = vi.fn()) {
  const { wrapper: QueryWrapper, queryClient } = makeQueryWrapper();
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryWrapper><KeyboardNavProvider>{children}</KeyboardNavProvider></QueryWrapper>;
  }
  render(<Layout period={period} onPeriodChange={onPeriodChange}>{null}</Layout>, { wrapper: Wrapper });
  return queryClient;
}

function gatedButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: DATA_GATED_PERIOD });
}

describe('Layout gated period', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('hides the button and its shortcut while the period has no data', async () => {
    const fetchSpy = stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HttpStatus.NotFound });
    const onPeriodChange = vi.fn();
    const queryClient = renderLayout(SELECTED_PERIOD, onPeriodChange);

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(queryClient.isFetching()).toBe(0);
    });
    fireEvent.keyDown(document, { key: GATED_PERIOD_KEY });

    expect(gatedButton()).toBeNull();
    expect(screen.getByRole('button', { name: SELECTED_PERIOD })).toBeDefined();
    expect(onPeriodChange).not.toHaveBeenCalled();
  });

  it('shows the button and binds its shortcut once the period has data', async () => {
    stubFetch(SUMMARY_WITH_DATA);
    const onPeriodChange = vi.fn();
    renderLayout(SELECTED_PERIOD, onPeriodChange);

    await waitFor(() => expect(gatedButton()).not.toBeNull());
    fireEvent.keyDown(document, { key: GATED_PERIOD_KEY });

    expect(onPeriodChange).toHaveBeenCalledWith(DATA_GATED_PERIOD);
  });

  it('offers the period when the check fails, so an outage never hides real data', async () => {
    stubFetch(SERVER_ERROR_BODY, { status: SERVER_ERROR_STATUS });

    renderLayout(SELECTED_PERIOD);

    await waitFor(() => expect(gatedButton()).not.toBeNull());
  });

  it('reveals the button when a later check finds data', async () => {
    const fetchSpy = stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HttpStatus.NotFound });
    const queryClient = renderLayout(SELECTED_PERIOD);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
      expect(queryClient.isFetching()).toBe(0);
    });
    expect(gatedButton()).toBeNull();

    stubFetch(SUMMARY_WITH_DATA);
    await queryClient.invalidateQueries();

    await waitFor(() => expect(gatedButton()).not.toBeNull());
  });

  it('keeps the button while the period is selected, even without data', () => {
    stubFetch({ error: WORKER_ERR_NO_DATA }, { status: HttpStatus.NotFound });

    renderLayout(DATA_GATED_PERIOD);

    expect(gatedButton()).not.toBeNull();
  });
});
