import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  computeAgreement,
  countMissing,
  estimateSpend,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  LIMIT_FLAG,
  type TurnScores,
  type TurnOutcome,
} from '../judge-agreement.js';
import { RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME } from '../judge-criteria.js';
import { YES_FLAG } from '../one-shot-eval.js';
import { estimateTurnTokens } from '../judge-usage.js';
import { makeTurn, TEST_PRICING } from './support/fixtures.js';
import { defined } from '../../src/__tests__/support/defined.js';


describe('parseArgs', () => {
  it('defaults the limit and accepts an explicit one', () => {
    const EXPLICIT_LIMIT = 5;
    expect(parseArgs([YES_FLAG]).limit).toBe(DEFAULT_LIMIT);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, String(EXPLICIT_LIMIT)]).limit).toBe(EXPLICIT_LIMIT);
  });

  it('refuses a limit above the hard maximum or not a positive integer', () => {
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, String(MAX_LIMIT + 1)]).error).toMatch(/hard maximum/);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, '0']).error).toMatch(/positive integer/);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, 'ten']).error).toMatch(/positive integer/);
  });
});

describe('agreement math', () => {
  it('computes exact-match rate and mean absolute difference per criterion', () => {
    const turns: TurnScores[] = [
      { perCriterion: { [RELEVANCE_EVAL_NAME]: 0.75, [COHERENCE_EVAL_NAME]: 1 }, consolidated: { [RELEVANCE_EVAL_NAME]: 0.75, [COHERENCE_EVAL_NAME]: 0.5 } },
      { perCriterion: { [RELEVANCE_EVAL_NAME]: 0.5 }, consolidated: { [RELEVANCE_EVAL_NAME]: 1 } },
    ];
    const PAIRED_TOTAL = 3;
    const ABS_DIFF_TOTAL = 4;
    const { byCriterion, overall } = computeAgreement(turns);

    expect(byCriterion[RELEVANCE_EVAL_NAME]).toMatchObject({ paired: 2, exactMatches: 1, exactMatchRate: 0.5, meanAbsDiff: 1 });
    expect(byCriterion[COHERENCE_EVAL_NAME]).toMatchObject({ paired: 1, exactMatches: 0, exactMatchRate: 0, meanAbsDiff: 2 });
    expect(overall).toMatchObject({ paired: PAIRED_TOTAL, exactMatches: 1 });
    expect(overall.exactMatchRate).toBeCloseTo(1 / PAIRED_TOTAL);
    expect(overall.meanAbsDiff).toBeCloseTo(ABS_DIFF_TOTAL / PAIRED_TOTAL);
  });

  it('rounds for exact match so a QAG fraction can still agree, and counts one-sided scores', () => {
    const turns: TurnScores[] = [
      { perCriterion: { [FAITHFULNESS_EVAL_NAME]: 0.8, [RELEVANCE_EVAL_NAME]: 0.5 }, consolidated: { [FAITHFULNESS_EVAL_NAME]: 0.75, [COHERENCE_EVAL_NAME]: 1 } },
    ];
    const FAITHFULNESS_SCALE_POINT_DIFF = 0.2;
    const { byCriterion } = computeAgreement(turns);
    expect(byCriterion[FAITHFULNESS_EVAL_NAME]).toMatchObject({ paired: 1, exactMatches: 1 });
    expect(defined(byCriterion[FAITHFULNESS_EVAL_NAME]).meanAbsDiff).toBeCloseTo(FAITHFULNESS_SCALE_POINT_DIFF);
    expect(byCriterion[RELEVANCE_EVAL_NAME]).toMatchObject({ paired: 0, exactMatchRate: null, meanAbsDiff: null, perCriterionOnly: 1 });
    expect(byCriterion[COHERENCE_EVAL_NAME]).toMatchObject({ paired: 0, consolidatedOnly: 1 });
  });

  it('counts the records each side failed to produce', () => {
    const outcomes: TurnOutcome[] = [{
      sessionId: 's', timestamp: 't', hasTools: false,
      expected: [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME],
      perCriterion: { [RELEVANCE_EVAL_NAME]: 1 },
      consolidated: { [RELEVANCE_EVAL_NAME]: 1, [COHERENCE_EVAL_NAME]: 1 },
    }];
    expect(countMissing(outcomes, 'perCriterion')).toEqual({ [COHERENCE_EVAL_NAME]: 1 });
    expect(countMissing(outcomes, 'consolidated')).toEqual({});
  });
});

describe('estimateSpend', () => {
  it('estimates per-criterion input as a multiple of the consolidated input', () => {
    const turns = [makeTurn({ toolResults: ['x'.repeat(4000)] }), makeTurn()];
    expect(estimateTurnTokens(defined(turns[1]))).toBeGreaterThan(0);
    const estimate = estimateSpend(turns, TEST_PRICING);
    expect(estimate.consolidatedInputTokens).toBe(estimateTurnTokens(defined(turns[0])) + estimateTurnTokens(defined(turns[1])));
    expect(estimate.perCriterionInputTokens).toBeGreaterThan(estimate.consolidatedInputTokens * 2);
    expect(estimate.totalUsd).toBeGreaterThan(0);
  });
});
