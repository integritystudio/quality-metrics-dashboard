/**
 * ScoreBadge calibration prop tests (FE-R1-UI).
 *
 * Tests that ScoreBadge accepts an optional `calibration` prop and uses
 * adaptiveScoreColorBand() to determine the color band when provided.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, within, cleanup } from '@testing-library/react';
import { ScoreBadge } from '../components/ScoreBadge.js';
import type { PercentileDistribution } from '../lib/quality-utils.js';

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeDistribution(overrides: Partial<PercentileDistribution> = {}): PercentileDistribution {
  return {
    p10: 0.30,
    p25: 0.48,
    p50: 0.60,
    p75: 0.72,
    p90: 0.83,
    ...overrides,
  };
}

// Helper: get aria-label from the rendered badge container
function getBadgeLabel(container: HTMLElement): string {
  return container.querySelector('[aria-label]')?.getAttribute('aria-label') ?? '';
}

// ---------------------------------------------------------------------------
// ScoreBadge without calibration — existing behavior must be preserved
// ---------------------------------------------------------------------------

describe('ScoreBadge without calibration prop', () => {
  it('renders excellent band for score 0.95 without calibration', () => {
    const { container } = render(<ScoreBadge score={0.95} metricName="relevance" />);
    expect(getBadgeLabel(container)).toMatch(/excellent/i);
  });

  it('renders failing band for score 0.3 without calibration', () => {
    const { container } = render(<ScoreBadge score={0.3} metricName="relevance" />);
    expect(getBadgeLabel(container)).toMatch(/failing/i);
  });

  it('renders adequate band for score 0.75 without calibration (uniform baseline)', () => {
    // 0.75 >= 0.6 but < 0.8 → adequate on uniform scale
    const { container } = render(<ScoreBadge score={0.75} metricName="relevance" />);
    expect(getBadgeLabel(container)).toMatch(/adequate/i);
  });
});

// ---------------------------------------------------------------------------
// ScoreBadge with calibration prop — new adaptive behavior
// ---------------------------------------------------------------------------

describe('ScoreBadge with calibration prop', () => {
  it('accepts calibration prop as part of the component interface', () => {
    const calibration = { distribution: makeDistribution(), sampleSize: 250 };
    expect(() =>
      render(
        <ScoreBadge
          score={0.75}
          metricName="relevance"
          calibration={calibration}
        />
      )
    ).not.toThrow();
  });

  it('uses excellent/good band for score 0.75 when calibration shows it is above p75', () => {
    // Distribution where 0.75 > p75 (0.72) — empiricalCDF(0.75) > 0.75 → should be 'good' or 'excellent'
    // Without calibration: 0.75 → 'adequate' (uniform).
    // With calibration: should be 'good' or 'excellent' because 0.75 is above p75.
    const distribution = makeDistribution({ p75: 0.72, p90: 0.83 });
    const calibration = { distribution, sampleSize: 200 };

    const { container } = render(
      <ScoreBadge
        score={0.75}
        metricName="relevance"
        calibration={calibration}
      />
    );
    const label = getBadgeLabel(container);
    // Should be 'good' or 'excellent', NOT 'adequate' (which uniform gives)
    expect(label).toMatch(/excellent|good/i);
    expect(label).not.toMatch(/adequate/i);
  });

  it('aria-label differs from uniform when calibration shifts the band', () => {
    const distribution = makeDistribution({ p50: 0.6, p75: 0.72, p90: 0.83 });

    const { container: noCalContainer } = render(
      <ScoreBadge score={0.75} metricName="relevance" />
    );
    const uniformLabel = getBadgeLabel(noCalContainer);

    cleanup();

    const { container: withCalContainer } = render(
      <ScoreBadge
        score={0.75}
        metricName="relevance"
        calibration={{ distribution, sampleSize: 200 }}
      />
    );
    const adaptiveLabel = getBadgeLabel(withCalContainer);

    // With calibration, 0.75 is above p75 → band should be higher than uniform 'adequate'
    expect(adaptiveLabel).not.toBe(uniformLabel);
  });

  it('behaves same as no-calibration when sampleSize is below MIN_QUANTILE_SAMPLE_SIZE', () => {
    // sampleSize=50 < 100 → quantile falls back to uniform → same aria-label as no-cal
    const calibration = { distribution: makeDistribution(), sampleSize: 50 };

    const { container: withCalContainer } = render(
      <ScoreBadge
        score={0.95}
        metricName="relevance"
        calibration={calibration}
      />
    );
    const withCalLabel = getBadgeLabel(withCalContainer);

    cleanup();

    const { container: noCalContainer } = render(
      <ScoreBadge score={0.95} metricName="relevance" />
    );
    const noCalLabel = getBadgeLabel(noCalContainer);

    // Both should be 'excellent' (0.95 on uniform = excellent, and sampleSize fallback = same)
    expect(withCalLabel).toBe(noCalLabel);
  });

  it('renders same band with and without calibration when no calibration is provided', () => {
    const { container: noCalContainer } = render(
      <ScoreBadge score={0.85} metricName="relevance" />
    );
    const noCalLabel = getBadgeLabel(noCalContainer);

    cleanup();

    const { container: undefinedCalContainer } = render(
      <ScoreBadge
        score={0.85}
        metricName="relevance"
        calibration={undefined}
      />
    );
    const undefinedCalLabel = getBadgeLabel(undefinedCalContainer);

    expect(undefinedCalLabel).toBe(noCalLabel);
  });

  it('uses within() to scope queries to the rendered container', () => {
    // Scope assertion to this render's container only — avoids leaking between tests
    const calibration = { distribution: makeDistribution(), sampleSize: 150 };

    const { container } = render(
      <ScoreBadge
        score={0.75}
        metricName="relevance"
        calibration={calibration}
      />
    );

    // The badge should show a band label in aria-label
    const scope = within(container as HTMLElement);
    const allLabeled = scope.getAllByRole('generic', { hidden: true });
    const labeled = allLabeled.filter(el => el.hasAttribute('aria-label'));
    expect(labeled.length).toBeGreaterThan(0);

    // The aria-label should show 'good' or 'excellent' (adaptive), not 'adequate' (uniform)
    const ariaLabel = labeled[0].getAttribute('aria-label') ?? '';
    expect(ariaLabel).toMatch(/excellent|good/i);
  });
});
