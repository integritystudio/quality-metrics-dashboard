/**
 * API route tests: /api/traces/:traceId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/parent/error-sanitizer.js', () => ({
  sanitizeErrorForResponse: (err: unknown) => String(err),
}));

vi.mock('../api/data-loader.js', () => ({
  loadEvaluationsByMetric: vi.fn(),
  loadEvaluationsForMetric: vi.fn(),
  loadEvaluationsByTraceId: vi.fn(),
  loadEvaluationsByTraceIds: vi.fn(),
  loadTracesByTraceId: vi.fn(),
  loadTracesBySessionId: vi.fn(),
  loadLogsByTraceId: vi.fn(),
  loadLogsBySessionId: vi.fn(),
  loadVerifications: vi.fn(),
  loadEvaluationsBySessionId: vi.fn(),
  checkHealth: vi.fn(),
}));

import { traceRoutes } from '../api/routes/traces.js';
import { loadTracesByTraceId, loadEvaluationsByTraceId } from '../api/data-loader.js';
import type { TraceDetailResponse } from './support/api-responses.js';
/**
 * A span shaped as `queryTraces` actually returns one: OTLP `fixed64`
 * timestamps decoded to `bigint` by the parent `numericNanosToEpochNanos`
 * codec. Fixtures that use a plain number here hide BigInt serialization
 * failures in any route that returns raw spans.
 *
 * Typed off the loader's own return type rather than `TraceSpan` — the route
 * receives the loader's projection, which makes `endTimeUnixNano` required-but-
 * possibly-undefined instead of optional.
 */
type LoadedSpan = Awaited<ReturnType<typeof loadTracesByTraceId>>[number];

/**
 * `EvaluationResult.timestamp` is a `bigint` too — the parent
 * `isoDatetimeToEpochNanos` codec decodes ISO strings to epoch nanos, and
 * `CloudBackend.queryEvaluations` builds it with `BigInt(...)` directly.
 */
type LoadedEval = Awaited<ReturnType<typeof loadEvaluationsByTraceId>>[number];

const START_NANOS = 1737000000000000000n;
const END_NANOS = 1737000001000000000n;
const EVAL_NANOS = 1737000000500000000n;

function makeSpan(overrides: Partial<LoadedSpan> = {}): LoadedSpan {
  return {
    traceId: 'trace-abc-123',
    spanId: 's1',
    name: 'tool:Read',
    kind: 'INTERNAL',
    startTimeUnixNano: START_NANOS,
    endTimeUnixNano: END_NANOS,
    durationMs: 1000,
    status: { code: 'OK' },
    attributes: {},
    ...overrides,
  };
}

function makeEval(overrides: Partial<LoadedEval> = {}): LoadedEval {
  return {
    timestamp: EVAL_NANOS,
    evaluationName: 'relevance',
    scoreValue: 0.9,
    traceId: 'trace-abc-123',
    ...overrides,
  };
}

beforeEach(vi.clearAllMocks);

describe('GET /traces/:traceId', () => {
  beforeEach(() => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);
  });

  it('returns 200 with traceId, spans, evaluations', async () => {
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(200);
    const body = await res.json() as TraceDetailResponse;
    expect(body).toHaveProperty('traceId', 'trace-abc-123');
    expect(body).toHaveProperty('spans');
    expect(body).toHaveProperty('evaluations');
  });

  it('returns spans and evaluations from data-loader', async () => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([makeSpan()]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([makeEval()]);

    const res = await traceRoutes.request('/traces/trace-abc-123');
    const body = await res.json() as TraceDetailResponse;
    expect(body.spans).toHaveLength(1);
    expect(body.evaluations).toHaveLength(1);
  });

  it('serializes the bigint timestamp on evaluations, not just spans', async () => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([makeEval()]);

    const res = await traceRoutes.request('/traces/trace-abc-123');

    expect(res.status).toBe(200);
    const body = await res.json() as { evaluations: { timestamp: string }[] };
    expect(body.evaluations[0]!.timestamp).toBe('1737000000500000000');
  });

  it('serializes bigint nanosecond timestamps instead of throwing', async () => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([makeSpan()]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);

    const res = await traceRoutes.request('/traces/trace-abc-123');

    expect(res.status).toBe(200);
    const body = await res.json() as { spans: { startTimeUnixNano: string; endTimeUnixNano: string }[] };
    // Decimal strings, not exponential notation — timestampToMs parses these back.
    expect(body.spans[0]!.startTimeUnixNano).toBe('1737000000000000000');
    expect(body.spans[0]!.endTimeUnixNano).toBe('1737000001000000000');
  });

  it('omits endTimeUnixNano when the span has none', async () => {
    vi.mocked(loadTracesByTraceId).mockResolvedValue([makeSpan({ endTimeUnixNano: undefined })]);
    vi.mocked(loadEvaluationsByTraceId).mockResolvedValue([]);

    const res = await traceRoutes.request('/traces/trace-abc-123');

    expect(res.status).toBe(200);
    const body = await res.json() as { spans: Record<string, unknown>[] };
    expect(body.spans[0]).not.toHaveProperty('endTimeUnixNano');
  });

  it('loads spans and evaluations in parallel', async () => {
    await traceRoutes.request('/traces/trace-abc-123');
    expect(vi.mocked(loadTracesByTraceId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadEvaluationsByTraceId)).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when loadTracesByTraceId throws', async () => {
    vi.mocked(loadTracesByTraceId).mockRejectedValue(new Error('fail'));
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(500);
  });

  it('returns 500 when loadEvaluationsByTraceId throws', async () => {
    vi.mocked(loadEvaluationsByTraceId).mockRejectedValue(new Error('fail'));
    const res = await traceRoutes.request('/traces/trace-abc-123');
    expect(res.status).toBe(500);
  });
});
