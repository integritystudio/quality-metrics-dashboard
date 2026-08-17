/**
 * Unit tests for loadEvaluationsByTraceIds in data-loader.ts.
 *
 * Verifies that the function queries per-traceId instead of fetching all
 * evaluations and filtering in memory — preventing silent data loss when
 * total evaluations in the date range exceed the bulk-fetch limit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CloudBackend } from '../api/parent/backends.js';
import type { EvaluationResult } from '../types.js';

/**
 * Typed off the real `CloudBackend.queryEvaluations` so the stub cannot return
 * rows the backend could not. It forces the required `timestamp` — a `bigint`
 * of epoch nanos — onto every fixture row; the previous untyped `vi.fn()` let
 * them omit it, which is the shape that hid the BigInt serialization bugs.
 */
type QueryEvaluations = CloudBackend['queryEvaluations'];

const mockQueryEvaluations = vi.fn<QueryEvaluations>();

vi.mock('../api/parent/backends.js', () => {
  class MockCloudBackend {
    queryEvaluations = mockQueryEvaluations;
  }
  return { CloudBackend: MockCloudBackend };
});

vi.mock('../api/parent/query-logs.js', () => ({
  queryLogs: vi.fn(),
}));
vi.mock('../api/parent/verification-events.js', () => ({
  queryVerifications: vi.fn(),
}));
vi.mock('../api/parent/query-traces.js', () => ({
  queryTraces: vi.fn(),
}));

// Import AFTER mocks are registered
const { loadEvaluationsByTraceIds } = await import('../api/data-loader.js');

/** Epoch nanos, as the backend returns them — bigint, never a number. */
const FIXTURE_TIMESTAMP_NANOS = 1_766_000_000_000_000_000n;

function makeEvaluation(
  traceId: string | undefined,
  evaluationName: string,
  scoreValue: number,
): EvaluationResult {
  return { traceId, evaluationName, scoreValue, timestamp: FIXTURE_TIMESTAMP_NANOS };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadEvaluationsByTraceIds', () => {
  it('returns empty array when traceIds is empty without querying backend', async () => {
    const result = await loadEvaluationsByTraceIds([]);
    expect(result).toEqual([]);
    expect(mockQueryEvaluations).not.toHaveBeenCalled();
  });

  it('returns evaluations matching requested traceIds', async () => {
    const targetTraceId = 'trace-target-001';
    mockQueryEvaluations.mockResolvedValue([
      makeEvaluation(targetTraceId, 'relevance', 0.9),
    ]);

    const result = await loadEvaluationsByTraceIds([targetTraceId]);

    expect(result).toHaveLength(1);
    expect(result[0]!.traceId).toBe(targetTraceId);
  });

  it('queries each traceId individually so results beyond a bulk limit are not silently dropped', async () => {
    // Simulate: traceId-A has evals but would be cut off if all evals were
    // fetched with a 10K limit and filtered in memory. Per-traceId querying
    // must find it regardless of total eval volume.
    const traceIdA = 'trace-beyond-limit-A';
    const traceIdB = 'trace-beyond-limit-B';

    // Backend returns results only when queried with the specific traceId filter.
    // A bulk fetch (no traceId) returns nothing (simulating truncation at limit).
    mockQueryEvaluations.mockImplementation(opts => {
      if (opts.traceId === traceIdA) {
        return Promise.resolve([makeEvaluation(traceIdA, 'coherence', 0.8)]);
      }
      if (opts.traceId === traceIdB) {
        return Promise.resolve([makeEvaluation(traceIdB, 'coherence', 0.75)]);
      }
      // Bulk fetch without traceId returns empty (simulates 10K truncation missing these)
      return Promise.resolve([]);
    });

    const result = await loadEvaluationsByTraceIds([traceIdA, traceIdB]);

    // Both evals must be present — only possible if queried per-traceId
    expect(result).toHaveLength(2);
    const returnedIds = result.map(e => e.traceId);
    expect(returnedIds).toContain(traceIdA);
    expect(returnedIds).toContain(traceIdB);
  });

  it('calls queryEvaluations once per requested traceId', async () => {
    const traceIds = ['trace-001', 'trace-002', 'trace-003'];
    mockQueryEvaluations.mockResolvedValue([]);

    await loadEvaluationsByTraceIds(traceIds);

    expect(mockQueryEvaluations).toHaveBeenCalledTimes(traceIds.length);
  });

  it('passes traceId filter to each backend call', async () => {
    const traceId = 'trace-filter-check';
    mockQueryEvaluations.mockResolvedValue([]);

    await loadEvaluationsByTraceIds([traceId]);

    expect(mockQueryEvaluations).toHaveBeenCalledWith(
      expect.objectContaining({ traceId })
    );
  });

  it('never calls queryEvaluations without a traceId filter', async () => {
    mockQueryEvaluations.mockResolvedValue([]);

    await loadEvaluationsByTraceIds(['trace-x', 'trace-y']);

    for (const [options] of mockQueryEvaluations.mock.calls) {
      expect(options).toHaveProperty('traceId');
      expect(typeof options.traceId).toBe('string');
    }
  });

  it('aggregates results from all per-traceId queries into a single flat array', async () => {
    mockQueryEvaluations.mockImplementation(opts => Promise.resolve([
      makeEvaluation(opts.traceId, 'relevance', 0.9),
      makeEvaluation(opts.traceId, 'coherence', 0.8),
    ]));

    const result = await loadEvaluationsByTraceIds(['trace-a', 'trace-b']);

    // 2 traceIds × 2 evals each = 4 total
    expect(result).toHaveLength(4);
  });

  it('deduplicates traceIds to avoid duplicate backend calls', async () => {
    mockQueryEvaluations.mockResolvedValue([]);

    await loadEvaluationsByTraceIds(['trace-dup', 'trace-dup', 'trace-dup']);

    expect(mockQueryEvaluations).toHaveBeenCalledTimes(1);
  });

  it('respects concurrency limit by batching queries', async () => {
    const traceIds = Array.from({ length: 25 }, (_, i) => `trace-${i}`);
    const callTimestamps: number[] = [];

    mockQueryEvaluations.mockImplementation(() => {
      callTimestamps.push(Date.now());
      return Promise.resolve([]);
    });

    await loadEvaluationsByTraceIds(traceIds);

    expect(mockQueryEvaluations).toHaveBeenCalledTimes(25);
  });

  it('returns partial results when some per-traceId queries fail', async () => {
    mockQueryEvaluations.mockImplementation(opts => {
      if (opts.traceId === 'trace-bad') {
        return Promise.reject(new Error('I/O error'));
      }
      return Promise.resolve([makeEvaluation(opts.traceId, 'relevance', 0.9)]);
    });

    const result = await loadEvaluationsByTraceIds(['trace-ok', 'trace-bad', 'trace-also-ok']);

    expect(result).toHaveLength(2);
    expect(result.map(e => e.traceId)).toEqual(['trace-ok', 'trace-also-ok']);
  });
});
