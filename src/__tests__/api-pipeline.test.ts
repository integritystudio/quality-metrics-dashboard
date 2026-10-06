/**
 * API route tests: /api/pipeline.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run,
 * and so do the parent's computeDashboardSummary and computePipelineView.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { pipelineRoutes } from '../api/routes/pipeline.js';
import type { PipelineResult } from '../types.js';
import { recentEvalNanos } from './support/fixtures.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

type PipelineResponse = PipelineResult & { period: string };

/** An `llm` evaluation counts as evidence; the summary drops makeEvaluation's `seed` default. */
const EVIDENCE_EVALUATOR_TYPE = 'llm';
/** Above relevance's warning threshold, so no stage reaches `alerted`. */
const HEALTHY_SCORES = [0.9, 0.95, 0.92];

beforeEach(() => {
  fixture.reset();
  fixture.setEvals(HEALTHY_SCORES.map((scoreValue, i) => evalToWire({
    evaluationName: 'relevance',
    scoreValue,
    evaluatorType: EVIDENCE_EVALUATOR_TYPE,
    timestamp: recentEvalNanos(),
  }, i + 1)));
});

describe('GET /pipeline', () => {

  it('rejects invalid period with 400', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period and pipeline data', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as PipelineResponse;
    expect(body.period).toBe('7d');
    expect(body.stages.map((stage) => stage.name)).toEqual(['ingested', 'scored', 'evaluated', 'alerted']);
  });

  it('carries every served evaluation through to evaluated, none alerted', async () => {
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    const body = await res.json() as PipelineResponse;
    const entryCounts = Object.fromEntries(body.stages.map((stage) => [stage.name, stage.entryCount]));
    expect(entryCounts).toEqual({ ingested: 3, scored: 3, evaluated: 3, alerted: 0 });
  });

  it('reports empty stages when there is no data', async () => {
    fixture.reset();
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    const body = await res.json() as PipelineResponse;
    expect(body.stages.every((stage) => stage.entryCount === 0)).toBe(true);
  });

  it('accepts all valid periods', async () => {
    for (const period of ['24h', '7d', '30d']) {
      const res = await pipelineRoutes.request(`/pipeline?period=${period}`);
      expect(res.status).toBe(200);
    }
  });

  it('returns 500 when backend throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await pipelineRoutes.request('/pipeline?period=7d');
    expect(res.status).toBe(500);
  });
});
