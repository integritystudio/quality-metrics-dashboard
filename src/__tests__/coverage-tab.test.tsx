/**
 * Coverage tab behaviour (CVG-1).
 *
 * Holds the tab, the route and the page open against the real query stack:
 * `useCoverage` → `useApiQuery` → `apiFetch`, the real `PageShell` and a memory
 * router. Only `useAuth` and `fetch` are substituted.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoverageMatrix } from '../types.js';
import type { CoverageResponse } from '../hooks/useCoverage.js';
import { CoveragePage } from '../pages/CoveragePage.js';
import { CoverageGrid } from '../components/CoverageGrid.js';
import { RoleSelector } from '../components/RoleSelector.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import {
  PAGE_SHELL_ERROR_HEADING, PAGE_SHELL_SKELETON_SELECTOR, apiErrorMessage, renderPage, stubPendingFetch,
} from './support/page-harness.js';

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({
    getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN),
    session: { allowedViews: [] },
  }),
}));

const HOME_PATH = '/';
const COVERAGE_PATH = '/coverage';
const PERIOD = '7d';
const PAGE_HEADING = 'Evaluation Coverage';
/** `useApiQuery` never retries a 401, so the error state renders on the first response. */
const HTTP_UNAUTHORIZED = 401;
const UNAUTHORIZED_BODY = { error: 'Unauthorized' };
const TRACE_COVERAGE_URL = '/api/coverage?period=7d&inputKey=traceId';
const SESSION_COVERAGE_URL = '/api/coverage?period=7d&inputKey=sessionId';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * relevance covers both traces; hallucination covers only trace-1 — so 3 of the
 * 4 pairs are covered (75%) and hallucination sits at 50%.
 */
function makeMatrix(overrides: Partial<CoverageMatrix> = {}): CoverageMatrix {
  return {
    metrics: ['hallucination', 'relevance'],
    inputs: ['trace-1', 'trace-2'],
    counts: [[1, 0], [1, 1]],
    coveredThreshold: 1,
    partialThreshold: 0,
    overallCoveragePercent: 75,
    ...overrides,
  };
}

function makeResponse(matrix: CoverageMatrix = makeMatrix()): CoverageResponse {
  return { period: PERIOD, ...matrix };
}

/** Answer each coverage URL with its own matrix, so a requery shows which one the page rendered. */
function stubCoverageByUrl(bodies: Record<string, CoverageResponse>) {
  const fetchSpy = vi.fn((url: string, _init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(bodies[url]), { headers: { 'Content-Type': 'application/json' } })),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

/**
 * The select's current value. Read through a narrow shape because RTL's
 * `getByLabelText<T>` constrains T to its own `HTMLElement`, which the SPA's
 * DOM lib version does not satisfy.
 */
function groupBySelectValue(): string {
  return (screen.getByLabelText('Group by') as unknown as { value: string }).value;
}

describe('Coverage tab navigation', () => {
  it('shows a Coverage tab', () => {
    renderPage(<RoleSelector />, HOME_PATH);

    expect(screen.getByRole('tab', { name: 'Coverage' })).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  it('navigates to /coverage when the Coverage tab is clicked', () => {
    const { location } = renderPage(<RoleSelector />, HOME_PATH);

    fireEvent.click(screen.getByRole('tab', { name: 'Coverage' }));

    expect(location.history.at(-1)).toBe(COVERAGE_PATH);
    expect(screen.getByRole('tab', { name: 'Coverage' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('CoveragePage', () => {
  it('renders the "Evaluation Coverage" heading', async () => {
    stubFetch(makeResponse());

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    expect(await screen.findByRole('heading', { name: PAGE_HEADING })).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  it('requests the matrix for the period with the bearer token', async () => {
    const fetchSpy = stubFetch(makeResponse());

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    await screen.findByRole('heading', { name: PAGE_HEADING });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(TRACE_COVERAGE_URL);
    expect(headersOf(init).Authorization).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('renders the matrix it is given as a grid of metric rows', async () => {
    stubFetch(makeResponse());

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    expect(await screen.findByRole('table', { name: 'Coverage matrix' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'hallucination' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'relevance' })).toBeTruthy();
  });

  it('shows an empty state when the matrix has no metrics or inputs', async () => {
    stubFetch(makeResponse(makeMatrix({ metrics: [], inputs: [], counts: [], overallCoveragePercent: 0 })));

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    expect(await screen.findByText('No coverage data available.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Coverage matrix' })).toBeNull();
  });

  it('defaults the "Group by" select to traceId', async () => {
    stubFetch(makeResponse());

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    await screen.findByRole('heading', { name: PAGE_HEADING });
    expect(groupBySelectValue()).toBe('traceId');
  });

  it('requeries by sessionId when "Group by" is switched and renders that matrix', async () => {
    const sessionMatrix = makeMatrix({ metrics: ['coherence'], inputs: ['session-1'], counts: [[1]], overallCoveragePercent: 100 });
    const fetchSpy = stubCoverageByUrl({
      [TRACE_COVERAGE_URL]: makeResponse(),
      [SESSION_COVERAGE_URL]: makeResponse(sessionMatrix),
    });
    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);
    await screen.findByRole('rowheader', { name: 'hallucination' });

    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'sessionId' } });

    expect(await screen.findByRole('rowheader', { name: 'coherence' })).toBeTruthy();
    expect(screen.queryByRole('rowheader', { name: 'hallucination' })).toBeNull();
    expect(groupBySelectValue()).toBe('sessionId');
    expect(fetchSpy.mock.calls.at(-1)?.[0]).toBe(SESSION_COVERAGE_URL);
  });

  it('shows the loading skeleton while the query is in flight', () => {
    stubPendingFetch();

    const { container } = renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    expect(container.querySelector(PAGE_SHELL_SKELETON_SELECTOR)).not.toBeNull();
    expect(screen.queryByRole('heading', { name: PAGE_HEADING })).toBeNull();
  });

  it('surfaces the error message when the query fails', async () => {
    stubFetch(UNAUTHORIZED_BODY, { status: HTTP_UNAUTHORIZED });

    renderPage(<CoveragePage period={PERIOD} />, COVERAGE_PATH);

    expect(await screen.findByRole('heading', { name: PAGE_SHELL_ERROR_HEADING })).toBeTruthy();
    expect(screen.getByText(apiErrorMessage(HTTP_UNAUTHORIZED, UNAUTHORIZED_BODY))).toBeTruthy();
    expect(screen.queryByRole('heading', { name: PAGE_HEADING })).toBeNull();
  });
});

describe('CoverageGrid', () => {
  it('renders the overall coverage percentage', () => {
    render(<CoverageGrid matrix={makeMatrix()} />);

    expect(screen.getByText('75.0%')).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  it('derives covered and missing cells from the counts, which carry no status', () => {
    render(<CoverageGrid matrix={makeMatrix()} />);

    expect(screen.getByRole('cell', { name: 'hallucination / trace-1: covered (1)' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'hallucination / trace-2: missing (0)' })).toBeTruthy();
  });

  it('lists a per-metric gap for each metric that misses an input', () => {
    render(<CoverageGrid matrix={makeMatrix()} />);

    const gaps = screen.getByRole('list');
    expect(gaps.textContent).toContain('hallucination');
    expect(gaps.textContent).toContain('50% covered');
    expect(gaps.textContent).toContain('1 input missing');
    // relevance covers every input, so it is not a gap.
    expect(gaps.textContent).not.toContain('relevance');
  });
});

/**
 * Source guard, in the style of `worker/__tests__/kv-choke-point.test.ts`: the
 * failure this protects against is the wiring being commented out again, which
 * is a property of the source rather than of any render.
 */
describe('App wiring (src/App.tsx source scan)', () => {
  // Vite rewrites import.meta.url to a non-file scheme under jsdom, so resolve
  // from the vitest root (the dashboard package) instead.
  const appSource = readFileSync(join(process.cwd(), 'src', 'App.tsx'), 'utf8');

  it('routes /coverage to CoveragePage', () => {
    expect(appSource).toMatch(/^\s*<Route path="\/coverage">/m);
    expect(appSource).toMatch(/^\s*<CoveragePage period=\{period\} \/>/m);
  });

  it('registers the "g v" shortcut, uncommented', () => {
    expect(appSource).toMatch(/^\s*useShortcut\('g v', 'Go to coverage'/m);
  });
});
