/**
 * Tests for loadEvaluationsByTraceIds in data-loader.ts.
 *
 * Verifies that the function queries per-traceId instead of fetching all
 * evaluations and filtering in memory — preventing silent data loss when
 * total evaluations in the date range exceed the bulk-fetch limit.
 *
 * The real CloudBackend runs against the fixture HTTP server, which applies
 * the `traceId` filter as obtool-api does, so each assertion reads the
 * requests that actually went over the wire.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';
import { loadEvaluationsByTraceIds } from '../api/data-loader.js';

const EVALUATIONS_PATH = '/v1/evaluations';
const TRACE_ID_PARAM = 'traceId';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

/** Serve one evaluation per (traceId, name) pair. */
function serveEvals(rows: Array<{ traceId: string; evaluationName: string }>): void {
  fixture.setEvals(rows.map((row, i) => evalToWire(row, i + 1)));
}

function evaluationRequests() {
  return fixture.requests().filter((r) => r.path === EVALUATIONS_PATH);
}

function requestedTraceIds(): Array<string | null> {
  return evaluationRequests().map((r) => r.query.get(TRACE_ID_PARAM));
}

describe('loadEvaluationsByTraceIds', () => {
  it('returns empty array when traceIds is empty without querying backend', async () => {
    const result = await loadEvaluationsByTraceIds([]);
    expect(result).toEqual([]);
    expect(evaluationRequests()).toHaveLength(0);
  });

  it('returns only the evaluations of the requested traceIds', async () => {
    serveEvals([
      { traceId: 'trace-target-001', evaluationName: 'relevance' },
      { traceId: 'trace-other', evaluationName: 'relevance' },
    ]);

    const result = await loadEvaluationsByTraceIds(['trace-target-001']);

    expect(result.map((e) => e.traceId)).toEqual(['trace-target-001']);
  });

  it('queries each traceId individually and sends its traceId filter', async () => {
    const traceIds = ['trace-001', 'trace-002', 'trace-003'];

    await loadEvaluationsByTraceIds(traceIds);

    expect(requestedTraceIds().sort()).toEqual(traceIds);
  });

  it('aggregates results from all per-traceId queries into a single flat array', async () => {
    serveEvals([
      { traceId: 'trace-a', evaluationName: 'relevance' },
      { traceId: 'trace-a', evaluationName: 'coherence' },
      { traceId: 'trace-b', evaluationName: 'relevance' },
      { traceId: 'trace-b', evaluationName: 'coherence' },
    ]);

    const result = await loadEvaluationsByTraceIds(['trace-a', 'trace-b']);

    // 2 traceIds × 2 evals each = 4 total
    expect(result).toHaveLength(4);
  });

  it('deduplicates traceIds to avoid duplicate backend calls', async () => {
    await loadEvaluationsByTraceIds(['trace-dup', 'trace-dup', 'trace-dup']);

    expect(requestedTraceIds()).toEqual(['trace-dup']);
  });

  it('issues one query per traceId past the concurrency limit', async () => {
    const traceIds = Array.from({ length: 25 }, (_, i) => `trace-${i}`);

    await loadEvaluationsByTraceIds(traceIds);

    expect(new Set(requestedTraceIds()).size).toBe(traceIds.length);
    expect(evaluationRequests()).toHaveLength(traceIds.length);
  });

  it('returns partial results when some per-traceId queries fail', async () => {
    serveEvals(['trace-ok', 'trace-bad', 'trace-also-ok'].map((traceId) => ({ traceId, evaluationName: 'relevance' })));
    fixture.failQuery(EVALUATIONS_PATH, TRACE_ID_PARAM, 'trace-bad');

    const result = await loadEvaluationsByTraceIds(['trace-ok', 'trace-bad', 'trace-also-ok']);

    expect(result.map((e) => e.traceId).sort()).toEqual(['trace-also-ok', 'trace-ok']);
  });
});
