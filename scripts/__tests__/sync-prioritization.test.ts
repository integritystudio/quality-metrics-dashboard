import { describe, it, expect } from 'vitest';
import { prioritizeTraces, computeBudgetAllocation, MIN_TRACE_BUDGET } from '../sync-to-kv.js';
import type { EvaluationResult } from '../../../dist/backends/index.js';

type KVEntry = { key: string; value: string };

/**
 * Thin wrapper around the exported computeBudgetAllocation + prioritizeTraces
 * to test the full allocation pipeline without running the sync main().
 */
function allocateBudget(
  highPriority: KVEntry[],
  traceChanged: KVEntry[],
  evalsByTrace: Map<string, EvaluationResult[]>,
  referencedTraceIds: Set<string>,
  writeBudget: number,
): { toWrite: KVEntry[]; deferred: number } {
  const { highPriorityBudget, traceBudget } = computeBudgetAllocation(highPriority.length, writeBudget);
  const prioritizedTraces = prioritizeTraces(traceChanged, evalsByTrace, referencedTraceIds);
  const toWrite = [
    ...highPriority.slice(0, highPriorityBudget),
    ...prioritizedTraces.slice(0, traceBudget),
  ];
  const changed = highPriority.length + traceChanged.length;
  const deferred = changed - toWrite.length;
  return { toWrite, deferred };
}

function makeEval(traceId: string, scoreValue: number, daysAgo = 1): EvaluationResult {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  return {
    traceId,
    evaluationName: 'relevance',
    scoreValue,
    timestamp: ts,
    sessionId: 'sess-x',
    evaluatorType: 'llm',
    id: `${traceId}-${scoreValue}`,
  } as EvaluationResult;
}

function makeTraceEntries(traceId: string): KVEntry[] {
  return [
    { key: `evaluations:trace:${traceId}`, value: '{}' },
    { key: `trace:${traceId}`, value: '{}' },
  ];
}

describe('prioritizeTraces', () => {
  it('ranks traces with lower worst scores higher', () => {
    const traceA = 'trace-a'; // worst score 0.1 — should rank first
    const traceB = 'trace-b'; // worst score 0.9 — should rank second

    const entries = [...makeTraceEntries(traceA), ...makeTraceEntries(traceB)];
    const evalsByTrace = new Map([
      [traceA, [makeEval(traceA, 0.1)]],
      [traceB, [makeEval(traceB, 0.9)]],
    ]);

    const result = prioritizeTraces(entries, evalsByTrace, new Set());
    const firstId = result[0].key.includes(traceA) ? traceA : traceB;
    expect(firstId).toBe(traceA);
  });

  it('ranks recent traces higher than old traces at equal scores', () => {
    const traceA = 'trace-recent'; // yesterday
    const traceB = 'trace-old';   // 25 days ago

    const entries = [...makeTraceEntries(traceA), ...makeTraceEntries(traceB)];
    const evalsByTrace = new Map([
      [traceA, [makeEval(traceA, 0.5, 1)]],
      [traceB, [makeEval(traceB, 0.5, 25)]],
    ]);

    const result = prioritizeTraces(entries, evalsByTrace, new Set());
    const firstId = result[0].key.includes(traceA) ? traceA : traceB;
    expect(firstId).toBe(traceA);
  });

  it('boosts traces referenced by worstEvaluations even over slightly better scores', () => {
    const traceA = 'trace-normal';     // score 0.5, not referenced
    const traceB = 'trace-referenced'; // score 0.6, referenced

    const entries = [...makeTraceEntries(traceA), ...makeTraceEntries(traceB)];
    const evalsByTrace = new Map([
      [traceA, [makeEval(traceA, 0.5)]],
      [traceB, [makeEval(traceB, 0.6)]],
    ]);
    // referencedByWorst weight (0.2) pushes traceB above traceA despite lower score priority
    const result = prioritizeTraces(entries, evalsByTrace, new Set([traceB]));
    const firstId = result[0].key.includes(traceB) ? traceB : traceA;
    expect(firstId).toBe(traceB);
  });

  it('groups both KV entries for the same traceId together', () => {
    const traceA = 'trace-grp-a';
    const traceB = 'trace-grp-b';

    const entries = [
      { key: `trace:${traceA}`, value: '{}' },
      { key: `evaluations:trace:${traceA}`, value: '{}' },
      { key: `trace:${traceB}`, value: '{}' },
      { key: `evaluations:trace:${traceB}`, value: '{}' },
    ];
    const evalsByTrace = new Map([
      [traceA, [makeEval(traceA, 0.1)]],
      [traceB, [makeEval(traceB, 0.9)]],
    ]);

    const result = prioritizeTraces(entries, evalsByTrace, new Set());
    // traceA should come first — verify both its entries are consecutive
    const traceAIndices = result.map((e, i) => e.key.includes(traceA) ? i : -1).filter(i => i >= 0);
    expect(traceAIndices).toHaveLength(2);
    expect(traceAIndices[1] - traceAIndices[0]).toBe(1);
  });

  it('assigns 1.0 worstScore (lowest priority) to traces with no evaluations', () => {
    const traceA = 'trace-evald';   // worst score 0.5 → higher priority
    const traceB = 'trace-noeval';  // no evals → defaults to 1.0

    const entries = [...makeTraceEntries(traceA), ...makeTraceEntries(traceB)];
    const evalsByTrace = new Map([[traceA, [makeEval(traceA, 0.5)]]]);
    // traceB not in evalsByTrace

    const result = prioritizeTraces(entries, evalsByTrace, new Set());
    const firstId = result[0].key.includes(traceA) ? traceA : traceB;
    expect(firstId).toBe(traceA);
  });

  it('returns empty array for empty input', () => {
    expect(prioritizeTraces([], new Map(), new Set())).toEqual([]);
  });

  it('skips entries with unexpected key format and warns', () => {
    const entries: KVEntry[] = [
      { key: 'unknown:whatever', value: '{}' },
      ...makeTraceEntries('trace-ok'),
    ];
    const evalsByTrace = new Map([['trace-ok', [makeEval('trace-ok', 0.5)]]]);
    const result = prioritizeTraces(entries, evalsByTrace, new Set());
    // Only the 2 valid trace entries should appear
    expect(result).toHaveLength(2);
    expect(result.every(e => e.key.includes('trace-ok'))).toBe(true);
  });
});

describe('budget allocation', () => {
  function makeHighPriorityEntries(count: number): KVEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      key: `dashboard:24h:${i}`,
      value: '{}',
    }));
  }

  function makeTracePool(count: number): {
    entries: KVEntry[];
    evalsByTrace: Map<string, EvaluationResult[]>;
  } {
    const entries: KVEntry[] = [];
    const evalsByTrace = new Map<string, EvaluationResult[]>();
    for (let i = 0; i < count; i++) {
      const id = `t-${i}`;
      entries.push(...makeTraceEntries(id));
      evalsByTrace.set(id, [makeEval(id, (i % 10) / 10)]);
    }
    return { entries, evalsByTrace };
  }

  it('reserves MIN_TRACE_BUDGET even when high-priority entries exceed budget', () => {
    const highPriority = makeHighPriorityEntries(400);
    const { entries: traceEntries, evalsByTrace } = makeTracePool(200);

    const { toWrite, deferred } = allocateBudget(highPriority, traceEntries, evalsByTrace, new Set(), 450);

    const highCount = toWrite.filter(e => e.key.startsWith('dashboard:')).length;
    const traceCount = toWrite.filter(e => e.key.startsWith('trace:') || e.key.startsWith('evaluations:trace:')).length;

    // budget=449, highPriorityBudget = min(400, 449-100) = 349, traceBudget = 100
    expect(highCount).toBe(349);
    expect(traceCount).toBe(100);
    // changed=400+400=800, toWrite=449, deferred=351
    expect(deferred).toBe(351);
  });

  it('gives full remaining budget to traces when high-priority is small', () => {
    const highPriority = makeHighPriorityEntries(10);
    const { entries: traceEntries, evalsByTrace } = makeTracePool(500);

    const { toWrite, deferred } = allocateBudget(highPriority, traceEntries, evalsByTrace, new Set(), 450);

    const highCount = toWrite.filter(e => e.key.startsWith('dashboard:')).length;
    const traceCount = toWrite.filter(e => e.key.startsWith('trace:') || e.key.startsWith('evaluations:trace:')).length;

    // budget=449, highPriorityBudget = min(10, 349) = 10, traceBudget = 439
    expect(highCount).toBe(10);
    expect(traceCount).toBe(439);
    // changed=10+1000=1010, toWrite=449, deferred=561
    expect(deferred).toBe(561);
  });

  it('handles zero changed traces gracefully', () => {
    const highPriority = makeHighPriorityEntries(20);

    const { toWrite, deferred } = allocateBudget(highPriority, [], new Map(), new Set(), 450);

    expect(toWrite).toHaveLength(20);
    expect(deferred).toBe(0);
  });

  it('handles budget smaller than MIN_TRACE_BUDGET', () => {
    const highPriority = makeHighPriorityEntries(10);
    const { entries: traceEntries, evalsByTrace } = makeTracePool(50);

    const { toWrite } = allocateBudget(highPriority, traceEntries, evalsByTrace, new Set(), 50);

    // budget=49, highPriorityBudget = max(0, min(10, 49-100)) = 0, traceBudget = 49
    // NOTE: when budget < MIN_TRACE_BUDGET, all slots go to traces; high-priority items receive nothing.
    // This is acceptable because budget < 100 only occurs with an explicit --budget override.
    const highCount = toWrite.filter(e => e.key.startsWith('dashboard:')).length;
    const traceCount = toWrite.filter(e => e.key.startsWith('trace:') || e.key.startsWith('evaluations:trace:')).length;
    expect(highCount).toBe(0);
    expect(traceCount).toBe(49);
  });
});

describe('prioritizeTraces: referenced trace prioritization', () => {
  it('ranks referenced traces before unreferenced traces with similar scores', () => {
    const referencedId = 'trace-worst-ref';
    const randomIds = Array.from({ length: 50 }, (_, i) => `trace-rand-${i}`);

    const allEntries: KVEntry[] = [];
    const evalsByTrace = new Map<string, EvaluationResult[]>();

    // Referenced trace has mediocre score (0.6)
    allEntries.push(...makeTraceEntries(referencedId));
    evalsByTrace.set(referencedId, [makeEval(referencedId, 0.6)]);

    // Random traces all have slightly worse score (0.55) but are not referenced
    for (const id of randomIds) {
      allEntries.push(...makeTraceEntries(id));
      evalsByTrace.set(id, [makeEval(id, 0.55)]);
    }

    const referencedTraceIds = new Set([referencedId]);

    // Slice to 20 entries (10 traces worth) to verify referenced trace makes the cut
    const maxEntries = 20;
    const prioritized = prioritizeTraces(allEntries, evalsByTrace, referencedTraceIds);
    const batch = prioritized.slice(0, maxEntries);

    // Referenced trace should be in the batch despite its higher (worse priority) score
    const batchTraceIds = new Set(
      batch
        .filter(e => e.key.startsWith('trace:'))
        .map(e => e.key.slice('trace:'.length)),
    );
    expect(batchTraceIds.has(referencedId)).toBe(true);
  });
});
