import { afterEach, describe, it, expect, vi } from 'vitest';
import { prioritizeTraces, computeBudgetAllocation, MIN_TRACE_BUDGET, type KVEntry } from '../sync-to-kv.js';
import type { EvaluationResult } from '../../../src/backends/index.js';
import { TIME_MS } from '../../../src/lib/core/units.js';
import { PERIOD_MS } from '../../src/lib/constants.js';
import { evaluation } from './support/evaluations.js';

const WORST_SCORE = 0.1;
const MID_SCORE = 0.5;
const REFERENCED_SCORE = 0.6;
const BEST_SCORE = 0.9;
const NEARLY_PERFECT_SCORE = 0.99;
const OLD_TRACE_DAYS_AGO = 25;
const PAST_RECENCY_WINDOW_DAYS = PERIOD_MS['30d'] / TIME_MS.DAY + 1;
const TRACE_KEY_MARKER = 'trace:';

/** A trace's two KV entries, the evaluations entry first. */
function traceEntries(traceId: string): KVEntry[] {
  return [{ key: `evaluations:trace:${traceId}`, value: '{}' }, { key: `trace:${traceId}`, value: '{}' }];
}

/** A map entry: one evaluation of `traceId` scored `scoreValue`, dated `daysAgo` before now. */
function scored(traceId: string, scoreValue: number, daysAgo = 1): [string, EvaluationResult[]] {
  const iso = new Date(Date.now() - daysAgo * TIME_MS.DAY).toISOString();
  return [traceId, [evaluation(`${traceId}-${scoreValue}`, iso, { traceId, scoreValue })]];
}

/** The trace id of each entry prioritizeTraces returns, in its order. */
function rankedIds(
  entries: KVEntry[],
  evals: Array<[string, EvaluationResult[]]> = [],
  referenced: string[] = [],
): string[] {
  return prioritizeTraces(entries, new Map(evals), new Set(referenced))
    .map(e => e.key.slice(e.key.lastIndexOf(TRACE_KEY_MARKER) + TRACE_KEY_MARKER.length));
}

describe('prioritizeTraces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ranks the trace with the lower worst score first', () => {
    const entries = [...traceEntries('best'), ...traceEntries('worst')];

    expect(rankedIds(entries, [scored('best', BEST_SCORE), scored('worst', WORST_SCORE)]))
      .toEqual(['worst', 'worst', 'best', 'best']);
  });

  it('ranks a recent trace above an old one with the same score', () => {
    const entries = [...traceEntries('old'), ...traceEntries('recent')];

    expect(rankedIds(entries, [scored('old', MID_SCORE, OLD_TRACE_DAYS_AGO), scored('recent', MID_SCORE)]))
      .toEqual(['recent', 'recent', 'old', 'old']);
  });

  it('ranks a trace a worst-evaluations card links to above a slightly worse unlinked one', () => {
    const entries = [...traceEntries('unlinked'), ...traceEntries('linked')];

    expect(rankedIds(entries, [scored('unlinked', MID_SCORE), scored('linked', REFERENCED_SCORE)], ['linked']))
      .toEqual(['linked', 'linked', 'unlinked', 'unlinked']);
  });

  it('ranks a trace without evaluations last, as if it scored 1', () => {
    const entries = [...traceEntries('unscored'), ...traceEntries('scored')];

    // Past the recency window, so only the score separates the two.
    expect(rankedIds(entries, [scored('scored', NEARLY_PERFECT_SCORE, PAST_RECENCY_WINDOW_DAYS)]))
      .toEqual(['scored', 'scored', 'unscored', 'unscored']);
  });

  it('keeps both entries of a trace together however the input interleaves them', () => {
    const [bestEvals, bestTrace] = traceEntries('best') as [KVEntry, KVEntry];
    const [worstEvals, worstTrace] = traceEntries('worst') as [KVEntry, KVEntry];

    expect(rankedIds([bestTrace, worstTrace, bestEvals, worstEvals], [scored('best', BEST_SCORE), scored('worst', WORST_SCORE)]))
      .toEqual(['worst', 'worst', 'best', 'best']);
  });

  it('groups the org-prefixed and bare entries of one trace as a single unit', () => {
    const ORG = 'f4286657-da73-4174-9e49-937f1bb6097f';
    const entries = [
      { key: `org:${ORG}:evaluations:trace:t1`, value: '{}' },
      ...traceEntries('other'),
      { key: `org:${ORG}:trace:t1`, value: '{}' },
      ...traceEntries('t1'),
    ];

    expect(rankedIds(entries, [scored('t1', WORST_SCORE), scored('other', BEST_SCORE)]))
      .toEqual(['t1', 't1', 't1', 't1', 'other', 'other']);
  });

  it('returns nothing for no entries', () => {
    expect(prioritizeTraces([], new Map(), new Set())).toEqual([]);
  });

  it('drops an entry whose key names no trace, and says so on stderr', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(rankedIds([{ key: 'unknown:whatever', value: '{}' }, ...traceEntries('ok')])).toEqual(['ok', 'ok']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Skipped 1 entries'));
  });
});

/** [case, changed high-priority entries, write budget, allocation]; one slot of every budget is meta:lastSync's. */
const ALLOCATIONS = [
  ['caps high priority so traces keep MIN_TRACE_BUDGET', 400, 450, { highPriorityBudget: 349, traceBudget: MIN_TRACE_BUDGET }],
  ['gives traces what high priority leaves, rounded down to whole pairs', 10, 450, { highPriorityBudget: 10, traceBudget: 438 }],
  ['admits no high priority when the budget is exactly MIN_TRACE_BUDGET', 5, MIN_TRACE_BUDGET + 1, { highPriorityBudget: 0, traceBudget: MIN_TRACE_BUDGET }],
  ['admits one high-priority entry one slot above that', 5, MIN_TRACE_BUDGET + 2, { highPriorityBudget: 1, traceBudget: MIN_TRACE_BUDGET }],
  ['gives every slot to traces below MIN_TRACE_BUDGET', 10, 50, { highPriorityBudget: 0, traceBudget: 48 }],
  ['allocates nothing from a budget only the meta entry fits', 5, 1, { highPriorityBudget: 0, traceBudget: 0 }],
] as const;

describe('computeBudgetAllocation', () => {
  it.each(ALLOCATIONS)('%s', (_case, highPriorityCount, writeBudget, allocation) => {
    expect(computeBudgetAllocation(highPriorityCount, writeBudget)).toEqual(allocation);
  });
});
