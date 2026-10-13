import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { AlertList } from '../components/AlertList.js';
import { EvaluationDetailPage } from '../pages/EvaluationDetailPage.js';
import { routes } from '../lib/routes.js';
import type { TriggeredAlert } from '../types.js';
import type { TraceEvaluationsResponse, WireEvaluation } from './support/api-responses.js';
import { TEST_ACCESS_TOKEN, headersOf, stubFetch } from './support/query-harness.js';
import { renderPage } from './support/page-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});


describe('ScoreBadge tooltip', () => {
  it('renders tooltip content when tooltip props provided', () => {
    const { container } = render(
      <ScoreBadge
        score={0.85}
        metricName="relevance"
        evaluator="gpt-4o"
        evaluatorType="llm"
        explanation="This response is highly relevant to the query."
        traceId="trace-abc-123"
      />
    );
    const wrapper = container.querySelector('.score-badge-wrapper');
    expect(wrapper).toBeInTheDocument();
    const tooltip = container.querySelector('.score-badge-tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(tooltip!.textContent).toContain('gpt-4o');
    expect(tooltip!.textContent).toContain('llm');
    expect(tooltip!.textContent).toContain('This response is highly relevant');
  });

  it('does not render tooltip without tooltip props', () => {
    const { container } = render(
      <ScoreBadge score={0.85} metricName="relevance" />
    );
    expect(container.querySelector('.score-badge-wrapper')).not.toBeInTheDocument();
    expect(container.querySelector('.score-badge-tooltip')).not.toBeInTheDocument();
  });

  it('renders "View full explanation" link with traceId', () => {
    const { container } = render(
      <ScoreBadge
        score={0.85}
        metricName="relevance"
        traceId="trace-abc-123"
      />
    );
    const link = container.querySelector('.tooltip-link');
    expect(link).toBeInTheDocument();
    expect(link!.getAttribute('href')).toBe('/evaluations/trace/trace-abc-123');
  });
});


describe('ChainOfThoughtPanel', () => {
  it('renders explanation in details element', () => {
    const { container } = render(
      <ChainOfThoughtPanel explanation="The model output is coherent and well-structured." />
    );
    const details = container.querySelector('details');
    expect(details).toBeInTheDocument();
    expect(details!.hasAttribute('open')).toBe(true);
    expect(details!.textContent).toContain('The model output is coherent');
  });

  it('renders evaluator inline without expandable config', () => {
    const { container } = render(
      <ChainOfThoughtPanel
        evaluator="claude-3.5-sonnet"
      />
    );
    expect(container.querySelectorAll('details').length).toBe(0);
    expect(container.textContent).toContain('claude-3.5-sonnet');
  });

  it('renders fallback when no data available', () => {
    const { container } = render(<ChainOfThoughtPanel />);
    expect(container.textContent).toContain('No chain-of-thought data available');
  });
});


describe('AlertList compound alerts', () => {
  function makeAlerts(): Array<TriggeredAlert & { metricName: string }> {
    return [
      {
        severity: 'warning',
        message: 'Relevance score below threshold',
        aggregation: 'avg',
        threshold: 0.7,
        actualValue: 0.65,
        direction: 'below',
        remediationHints: ['Check prompt quality'],
        metricName: 'relevance',
      },
      {
        severity: 'critical',
        message: 'Content quality crisis detected',
        aggregation: 'avg',
        threshold: 0.5,
        actualValue: 0.35,
        direction: 'below',
        isCompound: true,
        remediationHints: [
          'Review prompt templates',
          'Check model configuration',
          'Audit training data',
        ],
        relatedMetrics: ['relevance', 'hallucination', 'coherence'],
        metricName: 'content_quality_crisis',
      },
    ];
  }

  it('renders compound alert with full remediation hints', () => {
    const { container } = render(<AlertList alerts={makeAlerts()} />);
    const compoundCard = container.querySelector('.alert-compound');
    expect(compoundCard).toBeInTheDocument();
    expect(compoundCard!.textContent).toContain('Review prompt templates');
    expect(compoundCard!.textContent).toContain('Check model configuration');
    expect(compoundCard!.textContent).toContain('Audit training data');
  });

  it('renders related metric links for compound alerts', () => {
    const { container } = render(<AlertList alerts={makeAlerts()} />);
    const links = container.querySelectorAll('.alert-metric-link');
    expect(links.length).toBe(3);
    expect(links[0]!.getAttribute('href')).toBe('/metrics/relevance');
    expect(links[1]!.getAttribute('href')).toBe('/metrics/hallucination');
    expect(links[2]!.getAttribute('href')).toBe('/metrics/coherence');
  });

  it('renders threshold bar for compound alerts', () => {
    const { container } = render(<AlertList alerts={makeAlerts()} />);
    const bar = container.querySelector('.threshold-bar');
    expect(bar).toBeInTheDocument();
  });

  it('renders simple alerts without compound styling', () => {
    const { container } = render(<AlertList alerts={makeAlerts()} />);
    const items = container.querySelectorAll('.alert-item');
    expect(items.length).toBe(2);
    const simpleItem = Array.from(items).find(el => !el.classList.contains('alert-compound'));
    expect(simpleItem).toBeInTheDocument();
    expect(simpleItem!.textContent).toContain('Relevance score below threshold');
  });
});


const TRACE_ID = 'trace-123';
const NANOS_PER_MS = 1_000_000n;
const EVALUATED_AT_NANOS = String(BigInt(Date.parse('2026-02-17T12:00:00Z')) * NANOS_PER_MS);

const WIRE_EVALUATIONS: WireEvaluation[] = [
  {
    timestamp: EVALUATED_AT_NANOS,
    evaluationName: 'relevance',
    scoreValue: 0.92,
    scoreLabel: 'excellent',
    explanation: 'Highly relevant response',
    evaluator: 'gpt-4o',
    evaluatorType: 'llm',
    traceId: TRACE_ID,
  },
  {
    timestamp: EVALUATED_AT_NANOS,
    evaluationName: 'coherence',
    scoreValue: 0.78,
    scoreLabel: 'good',
    explanation: 'Mostly coherent',
    evaluator: 'gpt-4o',
    evaluatorType: 'llm',
    traceId: TRACE_ID,
  },
];

/** Mount the page at `path` under the real query stack and a memory router. */
function renderDetailPage(body: TraceEvaluationsResponse, path = routes.evaluationDetail(TRACE_ID)) {
  const fetchSpy = stubFetch(body);
  const view = renderPage(<EvaluationDetailPage traceId={TRACE_ID} />, path);
  return { ...view, fetchSpy };
}

describe('EvaluationDetailPage', () => {
  it('fetches the trace evaluations endpoint with the bearer token', async () => {
    const { fetchSpy } = renderDetailPage({ evaluations: WIRE_EVALUATIONS });
    await screen.findByRole('heading', { name: 'Trace Evaluations' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(`/api/evaluations/trace/${TRACE_ID}`);
    expect(headersOf(init)['Authorization']).toBe(`Bearer ${TEST_ACCESS_TOKEN}`);
  });

  it('renders evaluation cards when data is available', async () => {
    const { container } = renderDetailPage({ evaluations: WIRE_EVALUATIONS });
    await screen.findByRole('heading', { name: 'Trace Evaluations' });
    expect(container.textContent).toContain(TRACE_ID);
    expect(container.textContent).toContain('relevance');
    expect(container.textContent).toContain('coherence');
    expect(container.querySelectorAll('.eval-detail-card').length).toBe(2);
  });

  it('filters by metric query param', async () => {
    const { container } = renderDetailPage(
      { evaluations: WIRE_EVALUATIONS },
      routes.evaluationDetail(TRACE_ID, 'relevance'),
    );
    await screen.findByRole('heading', { name: 'relevance Evaluations' });
    expect(screen.getByRole('link', { name: 'View all evaluations' }))
      .toHaveAttribute('href', routes.evaluationDetail(TRACE_ID));
    expect(container.querySelectorAll('.eval-detail-card').length).toBe(1);
  });

  it('renders loading state', async () => {
    const { container } = renderDetailPage({ evaluations: WIRE_EVALUATIONS });
    expect(container.querySelector('.page-skeleton')).toBeInTheDocument();
    await screen.findByRole('heading', { name: 'Trace Evaluations' });
  });

  it('renders empty state when no evaluations', async () => {
    const { container } = renderDetailPage({ evaluations: [] });
    await screen.findByText('No Evaluations Found');
    expect(container.textContent).toContain('may not have been synced yet');
  });
});
