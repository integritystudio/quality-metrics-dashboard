import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { CQIHero } from '../components/CQIHero.js';
import { EvaluationTable, type EvalRow } from '../components/EvaluationTable.js';
import { CorrelationHeatmap } from '../components/CorrelationHeatmap.js';
import type { CompositeQualityIndex } from '../types.js';
import type { CorrelationFeature } from '../../../dist/lib/quality-feature-engineering.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// ScoreBadge (F1)
// ---------------------------------------------------------------------------

describe('ScoreBadge', () => {
  it('renders null score as N/A with aria-label', () => {
    render(<ScoreBadge score={null} metricName="relevance" />);
    const badge = screen.getByLabelText('relevance: no data');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('N/A');
  });

  it('renders high score with excellent band', () => {
    render(<ScoreBadge score={0.95} metricName="relevance" direction="maximize" />);
    const badge = screen.getByLabelText(/Score: 0.95, excellent/);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('0.95');
  });

  it('renders minimize direction hint', () => {
    render(<ScoreBadge score={0.05} metricName="hallucination" direction="minimize" />);
    expect(screen.getByLabelText(/lower is better/)).toBeInTheDocument();
  });

  it('uses custom label when provided', () => {
    render(<ScoreBadge score={0.85} metricName="coherence" label="0.8500" />);
    const badge = screen.getByLabelText(/Score: 0.85/);
    expect(badge.textContent).toContain('0.8500');
  });

  it('renders failing band for low maximize score', () => {
    render(<ScoreBadge score={0.3} metricName="relevance" direction="maximize" />);
    expect(screen.getByLabelText(/failing/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// CQIHero (F2)
// ---------------------------------------------------------------------------

function makeCQI(overrides: Partial<CompositeQualityIndex> = {}): CompositeQualityIndex {
  return {
    value: 0.82,
    featureVersion: '1.0',
    weights: { relevance: 0.2, coherence: 0.15, hallucination: 0.2 },
    contributions: [
      { metric: 'relevance', rawScore: 0.9, normalizedScore: 0.9, weight: 0.2, contribution: 0.18 },
      { metric: 'coherence', rawScore: 0.85, normalizedScore: 0.85, weight: 0.15, contribution: 0.1275 },
      { metric: 'hallucination', rawScore: 0.05, normalizedScore: 0.95, weight: 0.2, contribution: 0.19 },
    ],
    ...overrides,
  };
}

describe('CQIHero', () => {
  it('renders CQI value as percentage', () => {
    const { container } = render(<CQIHero cqi={makeCQI()} />);
    expect(container.textContent).toContain('82.0');
  });

  it('has correct region role and aria-label', () => {
    render(<CQIHero cqi={makeCQI()} />);
    const region = screen.getByRole('region');
    expect(region).toHaveAttribute('aria-label', 'Composite Quality Index: 82.0');
  });

  it('renders contribution segments with titles', () => {
    const { container } = render(<CQIHero cqi={makeCQI()} />);
    const segments = container.querySelectorAll('[title*="weight"]');
    expect(segments).toHaveLength(3);
  });

  it('renders screen reader table with caption', () => {
    const { container } = render(<CQIHero cqi={makeCQI()} />);
    const caption = container.querySelector('caption');
    expect(caption).toHaveTextContent('CQI Metric Breakdown');
  });

  it('handles empty contributions', () => {
    const { container } = render(<CQIHero cqi={makeCQI({ contributions: [] })} />);
    expect(container.textContent).toContain('82.0');
    expect(container.querySelectorAll('[title*="weight"]')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EvaluationTable (F6)
// ---------------------------------------------------------------------------

function makeEvalRows(): EvalRow[] {
  return [
    { score: 0.95, label: 'excellent', explanation: 'Great output', evaluator: 'judge-1', timestamp: '2026-02-17T00:00:00Z' },
    { score: 0.5, label: 'partial', explanation: 'Needs work', evaluator: 'judge-1', timestamp: '2026-02-16T00:00:00Z' },
    { score: 0.1, label: 'hallucinated', explanation: 'Contains hallucination', evaluator: 'judge-2', timestamp: '2026-02-15T00:00:00Z' },
  ];
}

describe('EvaluationTable', () => {
  it('renders all evaluation rows', () => {
    const { container } = render(<EvaluationTable evaluations={makeEvalRows()} />);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
  });

  it('renders score values in table cells', () => {
    const { container } = render(<EvaluationTable evaluations={makeEvalRows()} />);
    expect(container.textContent).toContain('0.9500');
    expect(container.textContent).toContain('0.5000');
    expect(container.textContent).toContain('0.1000');
  });

  it('renders category filter buttons', () => {
    render(<EvaluationTable evaluations={makeEvalRows()} />);
    const buttons = screen.getAllByRole('button');
    const labels = buttons.map(b => b.textContent);
    expect(labels).toContain('Pass');
    expect(labels).toContain('Review');
    expect(labels).toContain('Fail');
  });

  it('filters rows when category button clicked', () => {
    const { container } = render(<EvaluationTable evaluations={makeEvalRows()} />);
    const failBtn = screen.getAllByRole('button').find(b => b.textContent === 'Fail')!;
    fireEvent.click(failBtn);
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeLessThan(3);
  });

  it('renders empty state when no evaluations', () => {
    const { container } = render(<EvaluationTable evaluations={[]} />);
    expect(container.textContent).toContain('No evaluations match');
  });

  it('has sortable column headers with aria-sort', () => {
    const { container } = render(<EvaluationTable evaluations={makeEvalRows()} />);
    const sortableHeaders = container.querySelectorAll('th[aria-sort]');
    expect(sortableHeaders.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// CorrelationHeatmap (F5)
// ---------------------------------------------------------------------------

function makeCorrelations(): { correlations: CorrelationFeature[]; metrics: string[] } {
  const metrics = ['relevance', 'coherence', 'hallucination'];
  const correlations: CorrelationFeature[] = [
    {
      metricA: 'relevance', metricB: 'coherence',
      pearsonR: 0.73, spearmanR: 0.7, effectSize: 0.5,
      pValue: 0.001, significant: true,
      lagHours: 0, isKnownToxicCombo: false,
      coOccurrenceRate: 0, causalConfidence: 'correlation',
      featureVersion: '3.0',
    },
    {
      metricA: 'relevance', metricB: 'hallucination',
      pearsonR: -0.85, spearmanR: -0.82, effectSize: 0.9,
      pValue: 0.0001, significant: true,
      lagHours: 1, isKnownToxicCombo: true,
      coOccurrenceRate: 0.6, causalConfidence: 'correlation',
      featureVersion: '3.0',
    },
    {
      metricA: 'coherence', metricB: 'hallucination',
      pearsonR: -0.45, spearmanR: -0.4, effectSize: 0.3,
      pValue: 0.05, significant: false,
      lagHours: 0, isKnownToxicCombo: false,
      coOccurrenceRate: 0, causalConfidence: 'correlation',
      featureVersion: '3.0',
    },
  ];
  return { correlations, metrics };
}

describe('CorrelationHeatmap', () => {
  it('renders table with correct role', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    expect(container.querySelector('[role="table"]')).toBeInTheDocument();
  });

  it('renders column headers', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    const headers = container.querySelectorAll('[role="columnheader"]');
    expect(headers).toHaveLength(3);
  });

  it('renders diagonal cells as 1.00', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    // Diagonal cells have aria-label like "relevance vs relevance: 1.00"
    const allCells = container.querySelectorAll('[role="cell"]');
    let diagCount = 0;
    allCells.forEach(cell => {
      if (cell.textContent === '1.00') diagCount++;
    });
    expect(diagCount).toBe(3);
  });

  it('renders off-diagonal correlation values', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    expect(container.textContent).toContain('0.73');
    expect(container.textContent).toContain('-0.85');
  });

  it('renders cells with aria-labels', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    const cell = container.querySelector('[aria-label*="relevance vs coherence"]');
    expect(cell).toBeInTheDocument();
  });

  it('applies toxic border styling', () => {
    const { correlations, metrics } = makeCorrelations();
    const { container } = render(<CorrelationHeatmap correlations={correlations} metrics={metrics} />);
    const toxicCells = container.querySelectorAll('[style*="2px solid"]');
    expect(toxicCells.length).toBeGreaterThanOrEqual(2);
  });
});
