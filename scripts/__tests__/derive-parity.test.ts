import { describe, it, expect } from 'vitest';
import type { EvalRecord } from '../judge-evaluations.js';
import { compareRecords } from '../derive-parity.js';

function record(spanId: string, scoreValue: number, overrides: Partial<EvalRecord> = {}): EvalRecord {
  return {
    timestamp: '2026-09-26T12:00:00.000Z',
    evaluationName: 'tool_correctness',
    scoreValue,
    explanation: '',
    evaluator: 'rule',
    evaluatorType: 'rule',
    evaluatorKind: 'synthetic',
    cohort: 'normal',
    traceId: 't1',
    spanId,
    sessionId: 's1',
    ...overrides,
  } as EvalRecord;
}

describe('compareRecords', () => {
  it('is clean when both sides hold the same records', () => {
    const report = compareRecords([record('a', 1), record('b', 0)], [record('b', 0), record('a', 1)]);

    expect(report.clean).toBe(true);
    expect(report.byName).toEqual([{
      evaluationName: 'tool_correctness', local: 2, cloud: 2, matched: 2, scoreDiffers: 0, onlyLocal: 0, onlyCloud: 0, stampDiffers: 0,
    }]);
  });

  it('counts a score difference beyond the precision', () => {
    const report = compareRecords([record('a', 1)], [record('a', 0)]);

    expect(report.clean).toBe(false);
    expect(report.byName[0]!.scoreDiffers).toBe(1);
    expect(report.samples).toEqual([{ kind: 'scoreDiffers', key: 'tool_correctness|t1|a|s1', local: 1, cloud: 0 }]);
  });

  it('treats a difference below the precision as a match', () => {
    expect(compareRecords([record('a', 0.5)], [record('a', 0.500_000_01)]).clean).toBe(true);
  });

  it('counts records present on only one side', () => {
    const report = compareRecords([record('a', 1)], [record('b', 1)]);

    expect(report.byName[0]).toMatchObject({ onlyLocal: 1, onlyCloud: 1, matched: 0 });
  });

  it('pairs duplicate keys so one extra record counts once', () => {
    const report = compareRecords([record('a', 1), record('a', 1)], [record('a', 1)]);

    expect(report.byName[0]).toMatchObject({ matched: 1, onlyLocal: 1, onlyCloud: 0 });
  });

  it('reports a stamp difference without failing parity', () => {
    const report = compareRecords([record('a', 1)], [record('a', 1, { identityKeyRef: 'OBTOOL_API_KEY' })]);

    expect(report.clean).toBe(true);
    expect(report.byName[0]!.stampDiffers).toBe(1);
  });
});
