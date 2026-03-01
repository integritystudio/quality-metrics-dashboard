import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { ChainOfThoughtPanel } from '../components/ChainOfThoughtPanel.js';
import { AlertList } from '../components/AlertList.js';
import type { TriggeredAlert } from '../types.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// ScoreBadge tooltip (Feature 3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// ChainOfThoughtPanel (Feature 2)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AlertList compound alerts (Feature 4)
// ---------------------------------------------------------------------------

describe('AlertList compound alerts', () => {
  function makeAlerts(): (TriggeredAlert & { metricName: string })[] {
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
    expect(links[0].getAttribute('href')).toBe('/metrics/relevance');
    expect(links[1].getAttribute('href')).toBe('/metrics/hallucination');
    expect(links[2].getAttribute('href')).toBe('/metrics/coherence');
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

// ---------------------------------------------------------------------------
// EvaluationDetailPage (Feature 2) - basic render with mocked hook
// ---------------------------------------------------------------------------

vi.mock('../hooks/useTraceEvaluations.js', () => ({
  useTraceEvaluations: vi.fn(),
}));

const mockEvalData = [
  {
    timestamp: '2026-02-17T12:00:00Z',
    evaluationName: 'relevance',
    scoreValue: 0.92,
    scoreLabel: 'excellent',
    explanation: 'Highly relevant response',
    evaluator: 'gpt-4o',
    evaluatorType: 'llm' as const,
    traceId: 'trace-123',
  },
  {
    timestamp: '2026-02-17T12:00:00Z',
    evaluationName: 'coherence',
    scoreValue: 0.78,
    scoreLabel: 'good',
    explanation: 'Mostly coherent',
    evaluator: 'gpt-4o',
    evaluatorType: 'llm' as const,
    traceId: 'trace-123',
  },
];

describe('EvaluationDetailPage', () => {
  const originalSearch = window.location.search;
  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
    });
  });

  it('renders evaluation cards when data is available', async () => {
    const { useTraceEvaluations } = await import('../hooks/useTraceEvaluations.js');
    // @ts-expect-error -- partial mock: only fields consumed by component
    vi.mocked(useTraceEvaluations).mockReturnValue({
      data: mockEvalData,
      isLoading: false,
      error: null,
    });

    const { EvaluationDetailPage } = await import('../pages/EvaluationDetailPage.js');
    const { container } = render(<EvaluationDetailPage traceId="trace-123" />);

    expect(container.textContent).toContain('Trace Evaluations');
    expect(container.textContent).toContain('trace-123');
    expect(container.textContent).toContain('relevance');
    expect(container.textContent).toContain('coherence');
    const cards = container.querySelectorAll('.eval-detail-card');
    expect(cards.length).toBe(2);
  });

  it('filters by metric query param', async () => {
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?metric=relevance' },
      writable: true,
    });

    const { useTraceEvaluations } = await import('../hooks/useTraceEvaluations.js');
    // @ts-expect-error -- partial mock: only fields consumed by component
    vi.mocked(useTraceEvaluations).mockReturnValue({
      data: mockEvalData,
      isLoading: false,
      error: null,
    });

    const { EvaluationDetailPage } = await import('../pages/EvaluationDetailPage.js');
    const { container } = render(<EvaluationDetailPage traceId="trace-123" />);

    expect(container.textContent).toContain('relevance Evaluations');
    expect(container.textContent).toContain('View all evaluations');
    const cards = container.querySelectorAll('.eval-detail-card');
    expect(cards.length).toBe(1);
  });

  it('renders loading state', async () => {
    const { useTraceEvaluations } = await import('../hooks/useTraceEvaluations.js');
    // @ts-expect-error -- partial mock: only fields consumed by component
    vi.mocked(useTraceEvaluations).mockReturnValue({
      data: undefined,
      isLoading: true,
      error: null,
    });

    const { EvaluationDetailPage } = await import('../pages/EvaluationDetailPage.js');
    const { container } = render(<EvaluationDetailPage traceId="trace-123" />);
    expect(container.querySelector('.skeleton')).toBeInTheDocument();
  });

  it('renders empty state when no evaluations', async () => {
    const { useTraceEvaluations } = await import('../hooks/useTraceEvaluations.js');
    // @ts-expect-error -- partial mock: only fields consumed by component
    vi.mocked(useTraceEvaluations).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    });

    const { EvaluationDetailPage } = await import('../pages/EvaluationDetailPage.js');
    const { container } = render(<EvaluationDetailPage traceId="trace-123" />);
    expect(container.textContent).toContain('No Evaluations Found');
    expect(container.textContent).toContain('may not have been synced yet');
  });
});
