/**
 * SYNC-ORG-ENTRIES-UNTESTED: computeOrgEntries reads one org's evaluations once
 * and slices them per window in memory, reproducing the server's day-aligned
 * bounds (`queriedDateWindow`). These tests drive it through a fake backend that
 * behaves like the server's read (newest first, at most `limit` rows), so the
 * slicing, truncation and name matching are checked against the KV entries a
 * reader receives.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addRecentSession,
  computeOrgEntries,
  dashboardEntry,
  QUERY_LIMIT,
  type OrgComputation,
  type OrgReadBackend,
} from '../sync-to-kv.js';
import { CANARY_COHORT } from '../evaluation-constants.js';
import { BACKFILL_COHORT, RULE_EVALUATOR_TYPE, SEED_COHORT } from '../eval-record.js';
import type { EvaluationResult, TraceSpan } from '../../../src/backends/index.js';
import { evaluation, FIXTURE_METRIC, isoToNs } from './support/evaluations.js';
import { SESSION_ATTRIBUTES } from '../../../src/lib/otel/constants-otel.js';

/** 01:08 UTC, so every window's start is mid-day and the day rounding is visible. */
const NOW = new Date('2026-10-08T01:08:00.000Z');
const METRIC = FIXTURE_METRIC;
const TRACE_ID = 'a1b2c3d4e5f60718a1b2c3d4e5f60718';
const SESSION_ID = 'session-1';

const sessionSpan: TraceSpan = {
  traceId: TRACE_ID,
  spanId: 'a1b2c3d4e5f60718',
  name: 'session-span',
  kind: 'INTERNAL',
  startTimeUnixNano: isoToNs('2026-10-07T12:00:00.000Z'),
  attributes: { [SESSION_ATTRIBUTES.ID]: SESSION_ID },
};

function fakeBackend(evaluations: EvaluationResult[], spans: TraceSpan[] = []): OrgReadBackend {
  return {
    // Like the server: rows in the order given (newest first), at most `limit` of them.
    queryEvaluations: ({ limit }) => Promise.resolve(evaluations.slice(0, limit)),
    // The code-quality reads filter by attribute; the session/trace read does not.
    queryTraces: ({ attributeFilter }) => Promise.resolve(attributeFilter ? [] : spans),
  };
}

/** Non-home org: no degradation or calibration sidecar is read or written. */
function compute(evaluations: EvaluationResult[], spans: TraceSpan[] = []): Promise<OrgComputation> {
  return computeOrgEntries(fakeBackend(evaluations, spans), NOW, false);
}

function entryValue<T>(result: OrgComputation, key: string): T | undefined {
  const entry = result.allEntries.find(e => e.key === key);
  return entry ? JSON.parse(entry.value) as T : undefined;
}

type EvaluationRows = { rows: Array<{ explanation?: string }> };
type MetricDetail = { sampleCount: number; trend?: { previousValue: number } };
type SessionValue = { dataSources: { evaluations: Record<string, unknown> } };

function rowLabels(result: OrgComputation, period: string): string[] {
  const value = entryValue<EvaluationRows>(result, `metric:evaluations:${METRIC}:${period}`);
  return (value?.rows ?? []).map(r => r.explanation ?? '');
}

describe('computeOrgEntries period windows', () => {
  // now − 24h, now − 7d and now − 30d fall on Oct 7, Oct 1 and Sep 8; each window
  // starts at that day's UTC midnight and ends at the midnight after `now` (Oct 9).
  const cases: Array<[label: string, iso: string, periods: string[]]> = [
    ['last ms of the end day', '2026-10-08T23:59:59.999Z', ['24h', '7d', '30d']],
    ['next midnight after the end day', '2026-10-09T00:00:00.000Z', []],
    ['24h start-day midnight', '2026-10-07T00:00:00.000Z', ['24h', '7d', '30d']],
    ['last ms before the 24h start day', '2026-10-06T23:59:59.999Z', ['7d', '30d']],
    ['7d start-day midnight', '2026-10-01T00:00:00.000Z', ['7d', '30d']],
    ['last ms before the 7d start day', '2026-09-30T23:59:59.999Z', ['30d']],
    ['30d start-day midnight', '2026-09-08T00:00:00.000Z', ['30d']],
    ['last ms before the 30d start day', '2026-09-07T23:59:59.999Z', []],
  ];
  let result: OrgComputation;

  beforeAll(async () => {
    result = await compute(cases.map(([label, iso]) => evaluation(label, iso)));
  });

  it.each(cases)('puts a row at the %s (%s) in %j', (label, _iso, periods) => {
    const containing = ['24h', '7d', '30d'].filter(p => rowLabels(result, p).includes(label));

    expect(containing).toEqual(periods);
  });
});

describe('computeOrgEntries metric detail weeks', () => {
  it('starts the current week at the UTC midnight seven days back', async () => {
    const result = await compute([
      evaluation('7d start-day midnight', '2026-10-01T00:00:00.000Z'),
      evaluation('last ms before it', '2026-09-30T23:59:59.999Z'),
    ]);

    expect(entryValue<MetricDetail>(result, `metric:${METRIC}`)?.sampleCount).toBe(1);
  });

  it('baselines against the week starting at the UTC midnight 14 days back', async () => {
    const result = await compute([
      evaluation('current', '2026-10-05T12:00:00.000Z', { scoreValue: 0.5 }),
      evaluation('previous-week start', '2026-09-24T00:00:00.000Z', { scoreValue: 0.3 }),
      evaluation('before the previous week', '2026-09-23T23:59:59.999Z', { scoreValue: 0.1 }),
    ]);

    expect(entryValue<MetricDetail>(result, `metric:${METRIC}`)?.trend?.previousValue).toBe(0.3);
  });

  it('has no trend when the previous week holds no scores', async () => {
    const result = await compute([evaluation('current', '2026-10-05T12:00:00.000Z')]);

    expect(entryValue<MetricDetail>(result, `metric:${METRIC}`)?.trend).toBeUndefined();
  });

  // METRIC-WEEK-OVERLAP: day now − 7d belongs to the current week only.
  it('counts the boundary day in the current week alone', async () => {
    const result = await compute([
      evaluation('boundary day', '2026-10-01T12:00:00.000Z', { scoreValue: 0.9 }),
    ]);
    const detail = entryValue<MetricDetail>(result, `metric:${METRIC}`);

    expect(detail?.sampleCount).toBe(1);
    expect(detail?.trend).toBeUndefined();
  });

  it('ends the previous week at the last ms before the current week starts', async () => {
    const result = await compute([
      evaluation('current', '2026-10-05T12:00:00.000Z', { scoreValue: 0.5 }),
      evaluation('last ms of the previous week', '2026-09-30T23:59:59.999Z', { scoreValue: 0.3 }),
    ]);

    expect(entryValue<MetricDetail>(result, `metric:${METRIC}`)?.trend?.previousValue).toBe(0.3);
  });

  it('writes no detail for evaluations whose name only resembles the metric', async () => {
    const result = await compute([
      evaluation('capitalised', '2026-10-05T12:00:00.000Z', { evaluationName: 'Relevance' }),
      evaluation('suffixed', '2026-10-05T12:00:00.000Z', { evaluationName: 'relevance_v2' }),
      evaluation('prefixed', '2026-10-05T12:00:00.000Z', { evaluationName: 'answer_relevance' }),
    ]);

    expect(entryValue(result, `metric:${METRIC}`)).toBeUndefined();
  });

  it('counts only the evaluations whose name matches exactly', async () => {
    const result = await compute([
      evaluation('exact', '2026-10-05T12:00:00.000Z'),
      evaluation('capitalised', '2026-10-05T12:00:00.000Z', { evaluationName: 'Relevance' }),
      evaluation('suffixed', '2026-10-05T12:00:00.000Z', { evaluationName: 'relevance_v2' }),
    ]);

    expect(entryValue<MetricDetail>(result, `metric:${METRIC}`)?.sampleCount).toBe(1);
  });
});

describe('computeOrgEntries dashboard change hash (SYNC-DASHBOARD-TIMESTAMP-WRITES)', () => {
  /** Later on the same UTC day as NOW, so every window reads the same rows. */
  const LATER = new Date('2026-10-08T05:08:00.000Z');
  // Scores under the relevance warning, so the operator view carries alerting metrics.
  const rows = [0.1, 0.2, 0.3].map(score => evaluation(`score ${score}`, '2026-10-07T12:00:00.000Z', { scoreValue: score }));
  let first: OrgComputation;
  let second: OrgComputation;

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    first = await computeOrgEntries(fakeBackend(rows), NOW, false);
    vi.setSystemTime(LATER);
    second = await computeOrgEntries(fakeBackend(rows), LATER, false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function dashboardEntries(result: OrgComputation) {
    return result.allEntries.filter(e => e.key.startsWith('dashboard:'));
  }

  it('hashes every dashboard key the same on a second run over the same data', () => {
    const before = new Map(dashboardEntries(first).map(e => [e.key, e.hashBasis]));
    const after = dashboardEntries(second);

    expect(after.length).toBeGreaterThan(0);
    expect(after.map(e => e.key).sort()).toEqual([...before.keys()].sort());
    for (const e of after) {
      expect(e.hashBasis, e.key).toBeDefined();
      expect(e.hashBasis, e.key).toBe(before.get(e.key));
    }
  });

  it('still stores the run time in the auditor view', () => {
    const auditor = entryValue<{ timestamp: string }>(second, 'dashboard:7d:auditor');

    expect(auditor?.timestamp).toBe(LATER.toISOString());
  });

  it('changes the hash when the data changes', async () => {
    const changed = await computeOrgEntries(
      fakeBackend([...rows, evaluation('new', '2026-10-07T13:00:00.000Z', { scoreValue: 0.9 })]),
      LATER,
      false,
    );
    const hashOf = (r: OrgComputation) => r.allEntries.find(e => e.key === 'dashboard:7d')?.hashBasis;

    expect(hashOf(changed)).not.toBe(hashOf(second));
  });
});

describe('computeOrgEntries synthetic cohorts (BACKFILL-COHORT-COUNTS-AS-EVIDENCE)', () => {
  const rows = [0.7, 0.8, 0.9].map(score => evaluation(`score ${score}`, '2026-10-07T12:00:00.000Z', { scoreValue: score }));
  const dashboardHashes = (result: OrgComputation) =>
    new Map(result.allEntries.filter(e => e.key.startsWith('dashboard:')).map(e => [e.key, e.hashBasis]));

  it.each([BACKFILL_COHORT, SEED_COHORT])('leaves every dashboard key unchanged when a %s row is added', async (cohort) => {
    const synthetic = evaluation(cohort, '2026-10-07T13:00:00.000Z', { scoreValue: 0, cohort });
    const baseline = await compute(rows);
    const withSynthetic = await compute([synthetic, ...rows]);

    expect(dashboardHashes(baseline).size).toBeGreaterThan(0);
    expect(dashboardHashes(withSynthetic)).toEqual(dashboardHashes(baseline));
  });
});

describe('dashboardEntry', () => {
  const view = {
    timestamp: '2026-10-08T01:08:00.000Z',
    metrics: [{
      name: METRIC,
      period: { start: '2026-10-01T01:08:00.000Z', end: '2026-10-08T01:08:00.000Z' },
      worstExplanation: { score: 0.1, timestamp: '2026-10-07T12:00:00.000Z' },
    }],
  };
  const hashOf = (v: object) => dashboardEntry('dashboard:7d', v).hashBasis;

  it('ignores the run stamp and every metric period', () => {
    const laterRun = {
      timestamp: '2026-10-08T05:08:00.000Z',
      metrics: [{ ...view.metrics[0]!, period: { start: '2026-10-01T05:08:00.000Z', end: '2026-10-08T05:08:00.000Z' } }],
    };

    expect(hashOf(laterRun)).toBe(hashOf(view));
  });

  it('keeps a nested timestamp, which is event time', () => {
    const otherWorst = {
      ...view,
      metrics: [{ ...view.metrics[0]!, worstExplanation: { score: 0.1, timestamp: '2026-10-07T13:00:00.000Z' } }],
    };

    expect(hashOf(otherWorst)).not.toBe(hashOf(view));
  });

  it('stores the run stamp and period in the value', () => {
    expect(JSON.parse(dashboardEntry('dashboard:7d', view).value)).toEqual(view);
  });
});

describe('computeOrgEntries evaluation truncation', () => {
  // Newest first, as the server returns them. Canary filler is dropped before
  // aggregation, so only the two labelled rows reach the metric entries.
  const newest = evaluation('newest', '2026-10-07T12:00:00.000Z', { traceId: TRACE_ID });
  const oldest = evaluation('oldest', '2026-09-20T12:00:00.000Z');
  const filler = (count: number): EvaluationResult[] => Array.from({ length: count }, (_, i) =>
    evaluation(`canary-${i}`, '2026-10-06T12:00:00.000Z', { cohort: CANARY_COHORT }));

  describe('one row past QUERY_LIMIT', () => {
    let result: OrgComputation;

    beforeAll(async () => {
      result = await compute([newest, ...filler(QUERY_LIMIT - 1), oldest], [sessionSpan]);
    });

    it('reports the cap as hit', () => {
      expect(result.hitCap).toBe(true);
    });

    it('drops the oldest row and keeps the newest', () => {
      expect(rowLabels(result, '30d')).toEqual(['newest']);
      expect(rowLabels(result, '24h')).toEqual(['newest']);
    });

    it('marks every session partial', () => {
      const session = entryValue<SessionValue>(result, `session:${SESSION_ID}`);

      expect(session?.dataSources.evaluations.truncated).toBe(true);
    });
  });

  describe('exactly QUERY_LIMIT rows', () => {
    let result: OrgComputation;

    beforeAll(async () => {
      result = await compute([newest, ...filler(QUERY_LIMIT - 2), oldest], [sessionSpan]);
    });

    it('does not report the cap as hit', () => {
      expect(result.hitCap).toBe(false);
    });

    it('keeps every row', () => {
      expect(rowLabels(result, '30d')).toEqual(['newest', 'oldest']);
    });

    it('leaves sessions unmarked', () => {
      const session = entryValue<SessionValue>(result, `session:${SESSION_ID}`);

      expect(session?.dataSources.evaluations).not.toHaveProperty('truncated');
    });
  });
});

describe('addRecentSession', () => {
  const MAX = 3;
  const session = (id: string, date: string | null) => ({ id, date });
  const ids = (sessions: Array<{ id: string }>) => sessions.map(s => s.id);

  it('appends while the buffer is below its limit', () => {
    const sessions = [session('a', '2026-10-01'), session('b', null)];

    addRecentSession(sessions, session('c', '2026-09-01'), MAX);

    expect(ids(sessions)).toEqual(['a', 'b', 'c']);
  });

  it('replaces the oldest dated session with a newer one', () => {
    const sessions = [session('a', '2026-10-02'), session('b', '2026-10-01'), session('c', '2026-10-03')];

    addRecentSession(sessions, session('new', '2026-10-04'), MAX);

    expect(ids(sessions)).toEqual(['a', 'new', 'c']);
  });

  it('replaces the first of two equally old sessions', () => {
    const sessions = [session('a', '2026-10-02'), session('b', '2026-10-01'), session('c', '2026-10-01')];

    addRecentSession(sessions, session('new', '2026-10-04'), MAX);

    expect(ids(sessions)).toEqual(['a', 'new', 'c']);
  });

  it('drops an entry no newer than the oldest buffered session', () => {
    const sessions = [session('a', '2026-10-02'), session('b', '2026-10-01'), session('c', '2026-10-03')];

    addRecentSession(sessions, session('same-day', '2026-10-01'), MAX);
    addRecentSession(sessions, session('older', '2026-09-30'), MAX);

    expect(ids(sessions)).toEqual(['a', 'b', 'c']);
  });

  it('drops an undated entry from a full buffer', () => {
    const sessions = [session('a', null), session('b', null), session('c', null)];

    addRecentSession(sessions, session('undated', null), MAX);

    expect(ids(sessions)).toEqual(['a', 'b', 'c']);
  });

  it('replaces the last slot when no buffered session has a date', () => {
    const sessions = [session('a', null), session('b', null), session('c', null)];

    addRecentSession(sessions, session('dated', '2026-10-01'), MAX);

    expect(ids(sessions)).toEqual(['a', 'b', 'dated']);
  });

  it('keeps undated sessions and replaces the oldest dated one', () => {
    const sessions = [session('a', null), session('b', '2026-10-02'), session('c', '2026-10-01')];

    addRecentSession(sessions, session('new', '2026-10-04'), MAX);

    expect(ids(sessions)).toEqual(['a', 'b', 'new']);
  });
});

describe('coverage matrix rule-eval filter (CVG-RULE-FILTER)', () => {
  /** Rule evals on trace-rule, LLM judge eval on trace-llm — only trace-llm should appear in the matrix. */
  const RECENT = '2026-10-07T12:00:00.000Z';

  it('excludes rule-based evaluations and their inputs from the coverage matrix', async () => {
    const result = await compute([
      evaluation('rule eval', RECENT, { evaluationName: 'tool_correctness', traceId: 'trace-rule', evaluatorType: RULE_EVALUATOR_TYPE }),
      evaluation('llm eval', RECENT, { evaluationName: FIXTURE_METRIC, traceId: 'trace-llm', evaluatorType: 'llm' }),
    ]);

    const kvKey = `coverage:7d:traceId`;
    const matrix = entryValue<{ metrics: string[]; inputs: string[] }>(result, kvKey);
    expect(matrix).toBeDefined();
    expect(matrix!.metrics).not.toContain('tool_correctness');
    expect(matrix!.inputs).not.toContain('trace-rule');
    expect(matrix!.metrics).toContain(FIXTURE_METRIC);
    expect(matrix!.inputs).toContain('trace-llm');
  });

  it('produces an empty matrix when all evaluations are rule-based', async () => {
    const result = await compute([
      evaluation('rule only', RECENT, { evaluationName: 'tool_correctness', traceId: 'trace-rule', evaluatorType: RULE_EVALUATOR_TYPE }),
    ]);

    const matrix = entryValue<{ metrics: string[]; inputs: string[]; overallCoveragePercent: number }>(result, `coverage:7d:traceId`);
    expect(matrix).toBeDefined();
    expect(matrix!.metrics).toHaveLength(0);
    expect(matrix!.inputs).toHaveLength(0);
    expect(matrix!.overallCoveragePercent).toBe(0);
  });
});
