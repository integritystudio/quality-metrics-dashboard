/**
 * API route tests: /api/traces/:traceId.
 *
 * Approach C — fixture HTTP server. The real data-loader and CloudBackend run,
 * so the parent's Zod schema for queryTracesTool validates the dates the route
 * sends (the fix to traceQueryDates ensures ISO datetimes, not date-only strings).
 *
 * Fixtures are typed against the real parent return types — drift-detecting.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire, spanToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

import { traceRoutes } from '../api/routes/traces.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../api/data-loader.js';
import type { TraceDetailResponse } from './support/api-responses.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

/**
 * Typed off the loader's own return type so fixture types stay drift-detecting
 * (a parent shape change fails typecheck here before reaching runtime).
 */
type LoadedSpan = Awaited<ReturnType<typeof loadTracesByTraceId>>[number];
type LoadedEval = Awaited<ReturnType<typeof loadEvaluationsByTraceId>>[number];

const START_NANOS = 1737000000000000000n;
const END_NANOS = 1737000001000000000n;
const EVAL_NANOS = 1737000000500000000n;

// queryTraces validates traceId via TraceIdSchema: must be 32 lowercase hex chars, non-zero.
// PARAM_ID_RE (route-level check) accepts any word chars, but Zod rejects non-hex or short IDs.
const VALID_TRACE_ID = 'aaaabbbbccccdddd0000000000000001';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.reset();
});

describe('GET /traces/:traceId', () => {
  it('returns 200 with traceId, spans, evaluations', async () => {
    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as TraceDetailResponse;
    expect(body).toHaveProperty('traceId', VALID_TRACE_ID);
    expect(body).toHaveProperty('spans');
    expect(body).toHaveProperty('evaluations');
  });

  it('returns spans and evaluations from data-loader', async () => {
    fixture.setTraces([spanToWire({
      traceId: VALID_TRACE_ID,
      spanId: 's1',
      name: 'tool:Read',
      startTimeUnixNano: START_NANOS,
      endTimeUnixNano: END_NANOS,
      attributes: {},
    })]);
    fixture.setEvals([evalToWire({
      evaluationName: 'relevance',
      scoreValue: 0.9,
      timestamp: EVAL_NANOS,
      traceId: VALID_TRACE_ID,
    })]);

    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);
    const body = await res.json() as TraceDetailResponse;
    expect(body.spans).toHaveLength(1);
    expect(body.evaluations).toHaveLength(1);
  });

  it('serializes the bigint timestamp on evaluations, not just spans', async () => {
    fixture.setEvals([evalToWire({
      evaluationName: 'relevance',
      scoreValue: 0.9,
      timestamp: EVAL_NANOS,
      traceId: VALID_TRACE_ID,
    })]);

    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json() as { evaluations: { timestamp: string }[] };
    expect(body.evaluations[0]!.timestamp).toBe(String(EVAL_NANOS));
  });

  it('serializes bigint nanosecond timestamps instead of throwing', async () => {
    fixture.setTraces([spanToWire({
      traceId: VALID_TRACE_ID,
      spanId: 's1',
      startTimeUnixNano: START_NANOS,
      endTimeUnixNano: END_NANOS,
      attributes: {},
    })]);

    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json() as { spans: { startTimeUnixNano: string; endTimeUnixNano: string }[] };
    expect(body.spans[0]!.startTimeUnixNano).toBe(String(START_NANOS));
    expect(body.spans[0]!.endTimeUnixNano).toBe(String(END_NANOS));
  });

  it('loads spans and evaluations in parallel (both called)', async () => {
    // Both fixture endpoints respond — if either were missing the route would 500.
    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);
    expect(res.status).toBe(200);
  });

  it('returns 500 when loadTracesByTraceId throws', async () => {
    fixture.failPath('/v1/traces');
    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);
    expect(res.status).toBe(500);
  });

  it('returns 500 when loadEvaluationsByTraceId throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await traceRoutes.request(`/traces/${VALID_TRACE_ID}`);
    expect(res.status).toBe(500);
  });
});

// ── Type-only assertions for drift detection ────────────────────────────────

// Ensure that `makeSpan` / `makeEval` still match what the real loaders return.
// These assignments type-check but are never evaluated at runtime.
function _typeCheckLoadedSpan(): LoadedSpan {
  return {
    traceId: 'x',
    spanId: 'y',
    name: 'n',
    kind: 'INTERNAL',
    startTimeUnixNano: 0n,
    endTimeUnixNano: 0n,
    durationMs: 0,
    status: { code: 'OK' },
    attributes: {},
  };
}
function _typeCheckLoadedEval(): LoadedEval {
  return {
    evaluationName: 'relevance',
    scoreValue: 0,
    timestamp: 0n,
    traceId: 'x',
    evaluatorType: 'seed',
  };
}
void _typeCheckLoadedSpan;
void _typeCheckLoadedEval;
