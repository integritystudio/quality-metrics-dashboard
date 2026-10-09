/**
 * API route tests: /api/trends/:name.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run,
 * and so do the parent's metric registry, percentile, detail and dynamics
 * computations over what the fixture serves.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';
import { trendRoutes } from '../api/routes/trends.js';
import type { TrendDetailResponse } from './support/api-responses.js';
import { recentEvalNanos } from './support/fixtures.js';
import { DEFAULT_TREND_BUCKETS } from '../lib/constants.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

const METRIC = 'relevance';
const ONE_DAY_MS = 86_400_000;
/**
 * Scores spread over three days of the 7d window. Buckets are one day wide and
 * anchored at the request's now, so mid-day offsets keep each score clear of a
 * bucket edge.
 */
const SCORES_BY_DAYS_AGO = [
  { daysAgo: 5.5, score: 0.6 },
  { daysAgo: 3.5, score: 0.7 },
  { daysAgo: 1.5, score: 0.9 },
] as const;

/** One score mid-day on each of the last 7 days, so every bucket is scored and follows a scored one. */
const DAILY_DAYS_AGO = [6.5, 5.5, 4.5, 3.5, 2.5, 1.5, 0.5];
const DAILY_SCORES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8];

function serveRelevanceScores(): void {
  fixture.setEvals(SCORES_BY_DAYS_AGO.map(({ daysAgo, score }, i) => evalToWire({
    evaluationName: METRIC,
    scoreValue: score,
    timestamp: recentEvalNanos(daysAgo * ONE_DAY_MS),
  }, i + 1)));
}

beforeEach(() => {
  fixture.reset();
  serveRelevanceScores();
});

// /trends/:name

describe('GET /trends/:name', () => {
  it('returns 404 for unknown metric', async () => {
    const res = await trendRoutes.request('/trends/nonexistent?period=7d');
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid period', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=99d`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid buckets', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d&buckets=2`);
    expect(res.status).toBe(400);
  });

  it('returns 400 for buckets > 30', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d&buckets=31`);
    expect(res.status).toBe(400);
  });

  it('returns 200 with expected response shape', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d`);
    expect(res.status).toBe(200);
    const body = await res.json() as TrendDetailResponse;
    expect(body).toMatchObject({ metric: METRIC, period: '7d', bucketCount: DEFAULT_TREND_BUCKETS });
    expect(body.trendData).toHaveLength(body.bucketCount);
  });

  it('counts every served score and computes overall percentiles from them', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d`);
    const body = await res.json() as TrendDetailResponse;
    expect(body.totalEvaluations).toBe(SCORES_BY_DAYS_AGO.length);
    expect(body.overallPercentiles?.p50).toBeCloseTo(0.7, 3);
    expect(body.trendData.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(SCORES_BY_DAYS_AGO.length);
  });

  it('averages each scored bucket and leaves empty buckets without a trend', async () => {
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d`);
    const body = await res.json() as TrendDetailResponse;
    const scored = body.trendData.filter((bucket) => bucket.count > 0);
    expect(scored).toHaveLength(SCORES_BY_DAYS_AGO.length);
    expect(scored.map((bucket) => bucket.avg)).toEqual(SCORES_BY_DAYS_AGO.map(({ score }) => score));
    expect(body.trendData.filter((bucket) => bucket.count === 0).every((bucket) => bucket.trend === null)).toBe(true);
  });

  it('computes trend and dynamics for a bucket whose previous bucket was scored', async () => {
    fixture.setEvals(DAILY_DAYS_AGO.map((daysAgo, i) => evalToWire({
      evaluationName: METRIC,
      scoreValue: DAILY_SCORES[i],
      timestamp: recentEvalNanos(daysAgo * ONE_DAY_MS),
    }, i + 1)));
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d&buckets=${DAILY_DAYS_AGO.length}`);
    const body = await res.json() as TrendDetailResponse;
    const [first, ...rest] = body.trendData;
    expect(first?.trend).toBeNull();
    expect(first?.dynamics).toBeNull();
    for (const bucket of rest) {
      expect(bucket.trend?.direction).toBe('improving');
      expect(bucket.dynamics?.velocity).toBeGreaterThan(0);
    }
  });

  it('accepts valid bucket counts', async () => {
    for (const buckets of [3, 7, 15, 30]) {
      const res = await trendRoutes.request(`/trends/${METRIC}?period=7d&buckets=${buckets}`);
      expect(res.status).toBe(200);
      const body = await res.json() as TrendDetailResponse;
      expect(body.trendData).toHaveLength(buckets);
    }
  });

  it('returns empty buckets and no percentiles when there is no data', async () => {
    fixture.reset();
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d`);
    const body = await res.json() as TrendDetailResponse;
    expect(body.totalEvaluations).toBe(0);
    expect(body.overallPercentiles).toBeUndefined();
    expect(body.trendData.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await trendRoutes.request(`/trends/${METRIC}?period=7d`);
    expect(res.status).toBe(500);
  });
});
