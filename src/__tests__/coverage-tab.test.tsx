/**
 * Coverage tab behaviour (CVG-1).
 *
 * Replaces the todo stubs that stood from 2026-03-27 while the tab was hidden:
 * the dense metric x input payload exceeded Workers KV's 25 MiB value limit, so
 * the writer, the route and these three UI wirings were all commented out. The
 * columnar matrix replaced that payload; these tests hold the feature open.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageShellProps } from './test-types.js';
import type { CoverageMatrix } from '../types.js';

// jsdom + React cold-start can exceed the default 5000ms on the first render test.
const TEST_TIMEOUT_MS = 30_000;

const { setLocation } = vi.hoisted(() => ({ setLocation: vi.fn() }));

vi.mock('../hooks/useCoverage.js', () => ({ useCoverage: vi.fn() }));

vi.mock('../components/PageShell.js', () => ({
  PageShell: ({ isLoading, error, children }: PageShellProps) => {
    if (isLoading) return <div data-testid="page-shell-loading" />;
    if (error) return <div data-testid="page-shell-error">{error.message}</div>;
    return <div data-testid="page-shell">{children}</div>;
  },
}));

vi.mock('wouter', () => ({ useLocation: () => ['/', setLocation] }));

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ session: { allowedViews: [] } }),
}));

import { useCoverage } from '../hooks/useCoverage.js';
import { CoveragePage } from '../pages/CoveragePage.js';
import { CoverageGrid } from '../components/CoverageGrid.js';
import { RoleSelector } from '../components/RoleSelector.js';

const mockUseCoverage = vi.mocked(useCoverage);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

type MockQueryResult = {
  data: (CoverageMatrix & { period: string }) | undefined;
  isLoading: boolean;
  error: Error | null;
};

function mockQuery(result: MockQueryResult) {
  mockUseCoverage.mockReturnValue(result as unknown as ReturnType<typeof useCoverage>);
}

function mockLoaded(matrix: CoverageMatrix = makeMatrix()) {
  mockQuery({ data: { period: '7d', ...matrix }, isLoading: false, error: null });
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
    render(<RoleSelector />);

    expect(screen.getByRole('tab', { name: 'Coverage' })).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  it('navigates to /coverage when the Coverage tab is clicked', () => {
    render(<RoleSelector />);

    fireEvent.click(screen.getByRole('tab', { name: 'Coverage' }));

    expect(setLocation).toHaveBeenCalledWith('/coverage');
  });
});

describe('CoveragePage', () => {
  it('renders the "Evaluation Coverage" heading', () => {
    mockLoaded();

    render(<CoveragePage period="7d" />);

    expect(screen.getByRole('heading', { name: 'Evaluation Coverage' })).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  it('renders the matrix it is given as a grid of metric rows', () => {
    mockLoaded();

    render(<CoveragePage period="7d" />);

    expect(screen.getByRole('table', { name: 'Coverage matrix' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'hallucination' })).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'relevance' })).toBeTruthy();
  });

  it('shows an empty state when the matrix has no metrics or inputs', () => {
    mockLoaded(makeMatrix({ metrics: [], inputs: [], counts: [], overallCoveragePercent: 0 }));

    render(<CoveragePage period="7d" />);

    expect(screen.getByText('No coverage data available.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Coverage matrix' })).toBeNull();
  });

  it('defaults the "Group by" select to traceId', () => {
    mockLoaded();

    render(<CoveragePage period="7d" />);

    expect(groupBySelectValue()).toBe('traceId');
    expect(mockUseCoverage).toHaveBeenCalledWith('7d', 'traceId');
  });

  it('requeries by sessionId when "Group by" is switched', () => {
    mockLoaded();
    render(<CoveragePage period="7d" />);

    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'sessionId' } });

    expect(groupBySelectValue()).toBe('sessionId');
    expect(mockUseCoverage).toHaveBeenLastCalledWith('7d', 'sessionId');
  });

  it('shows the loading skeleton while the query is in flight', () => {
    mockQuery({ data: undefined, isLoading: true, error: null });

    render(<CoveragePage period="7d" />);

    expect(screen.getByTestId('page-shell-loading')).toBeTruthy();
  });

  it('surfaces the error message when the query fails', () => {
    mockQuery({ data: undefined, isLoading: false, error: new Error('API error: 500') });

    render(<CoveragePage period="7d" />);

    expect(screen.getByTestId('page-shell-error').textContent).toBe('API error: 500');
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
