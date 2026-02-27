import { describe, it, expect } from 'vitest';
import { prioritizeTraces } from '../sync-to-kv.js';
import type { EvaluationResult } from '../../../dist/backends/index.js';

type KVEntry = { key: string; value: string };

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
