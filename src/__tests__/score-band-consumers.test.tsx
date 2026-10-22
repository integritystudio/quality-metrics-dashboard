/**
 * QualityLiveIndicator and ConfidencePanel band through scoreColorBand
 * (the parent's SCORE_BAND_* thresholds), exposed as `data-band`; a live chip
 * whose metric the org has calibrated bands on that metric's own scale, as
 * ScoreBadge does. The live indicator runs on the real query stack with only
 * useAuth and fetch substituted; ConfidencePanel is rendered from props.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QualityLiveIndicator } from '../components/QualityLiveIndicator.js';
import { ConfidencePanel } from '../components/ConfidencePanel.js';
import { CalibrationProvider } from '../contexts/CalibrationContext.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../lib/http-constants.js';
import type { CalibrationResponse } from '../lib/validation/dashboard-schemas.js';
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

const LIVE_PATH = '/api/quality/live';
const CALIBRATION_PATH = '/api/calibration';
const URL_BASE = 'http://localhost';

const CALIBRATED_DISTRIBUTION = { p10: 0.30, p25: 0.48, p50: 0.60, p75: 0.72, p90: 0.83 };
const CALIBRATED_SAMPLE_SIZE = 250;
const CALIBRATED_METRICS = ['relevance', 'faithfulness', 'task_completion'];

function calibration(): CalibrationResponse {
  return {
    distributions: Object.fromEntries(CALIBRATED_METRICS.map((name) => [name, CALIBRATED_DISTRIBUTION])),
    sampleCounts: Object.fromEntries(CALIBRATED_METRICS.map((name) => [name, CALIBRATED_SAMPLE_SIZE])),
    lastCalibrated: TIMESTAMP,
  };
}

function stubFetchByPath(bodies: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn((url: string) =>
    Promise.resolve(new Response(JSON.stringify(bodies[new URL(url, URL_BASE).pathname]), {
      headers: { [CONTENT_TYPE_HEADER]: ContentType.Json },
    })),
  ));
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

describe('QualityLiveIndicator with calibration', () => {
  it.each([
    { name: 'faithfulness', score: 0.72, band: 'excellent' },
    { name: 'task_completion', score: 0.55, band: 'adequate' },
    { name: 'relevance', score: 0.75, band: 'good' },
    { name: 'coherence', score: 0.45, band: 'poor' },
  ])('bands $name at $score as $band', async ({ name, score, band }) => {
    stubFetchByPath({ [LIVE_PATH]: liveData([{ name, score }]), [CALIBRATION_PATH]: calibration() });

    render(<CalibrationProvider><QualityLiveIndicator /></CalibrationProvider>, makeQueryWrapper());

    const chip = await screen.findByTitle((title) => title.startsWith(`${name}: `));
    await waitFor(() => expect(chip.dataset.band).toBe(band));
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
