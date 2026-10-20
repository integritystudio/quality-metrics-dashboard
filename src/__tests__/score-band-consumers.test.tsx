/**
 * QualityLiveIndicator and ConfidencePanel band through scoreColorBand
 * (the parent's SCORE_BAND_* thresholds), exposed as `data-band`. The live
 * indicator runs on the real query stack with only useAuth and fetch substituted;
 * ConfidencePanel is rendered from props.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QualityLiveIndicator } from '../components/QualityLiveIndicator.js';
import { ConfidencePanel } from '../components/ConfidencePanel.js';
import type { QualityLiveData } from '../types.js';
import { TEST_ACCESS_TOKEN, makeQueryWrapper, stubFetch } from './support/query-harness.js';

vi.mock('../contexts/AuthContext.js', () => ({
  useAuth: () => ({ getAccessToken: () => Promise.resolve(TEST_ACCESS_TOKEN) }),
}));

const TIMESTAMP = '2026-01-15T12:00:00.000Z';

function liveData(metrics: Array<{ name: string; score: number }>): QualityLiveData {
  return {
    metrics: metrics.map((m) => ({ ...m, evaluatorType: 'seed', timestamp: TIMESTAMP })),
    sessionCount: 1,
    lastUpdated: TIMESTAMP,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('QualityLiveIndicator', () => {
  it.each([
    { name: 'relevance', score: 0.95, band: 'excellent' },
    { name: 'relevance', score: 0.85, band: 'good' },
    { name: 'coherence', score: 0.45, band: 'poor' },
    { name: 'hallucination', score: 0.05, band: 'excellent' },
    { name: 'hallucination', score: 0.9, band: 'failing' },
    { name: 'Hallucination', score: 0.9, band: 'failing' },
  ])('bands $name at $score as $band', async ({ name, score, band }) => {
    stubFetch(liveData([{ name, score }]));

    render(<QualityLiveIndicator />, makeQueryWrapper());

    const chip = await screen.findByTitle((title) => title.startsWith(`${name}: `));
    expect(chip.dataset.band).toBe(band);
  });
});

describe('ConfidencePanel agreement', () => {
  it.each([
    { agreement: 0.95, band: 'excellent' },
    { agreement: 0.85, band: 'good' },
    { agreement: 0.3, band: 'failing' },
  ])('bands agreement $agreement as $band', ({ agreement, band }) => {
    const { container } = render(
      <ConfidencePanel
        confidence={{ level: 'high', sampleCount: 10, scoreStdDev: null, evaluatorCount: 2, evaluatorAgreement: agreement }}
      />,
    );

    const value = container.querySelector<HTMLElement>('.agreement-value');
    expect(value?.dataset.band).toBe(band);
  });
});
