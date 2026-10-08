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


describe('parseArgs', () => {
  it('defaults the limit and accepts an explicit one', () => {
    expect(parseArgs([YES_FLAG]).limit).toBe(DEFAULT_LIMIT);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, '5']).limit).toBe(5);
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
    const { byCriterion, overall } = computeAgreement(turns);

    expect(byCriterion[RELEVANCE_EVAL_NAME]).toMatchObject({ paired: 2, exactMatches: 1, exactMatchRate: 0.5, meanAbsDiff: 1 });
    expect(byCriterion[COHERENCE_EVAL_NAME]).toMatchObject({ paired: 1, exactMatches: 0, exactMatchRate: 0, meanAbsDiff: 2 });
    expect(overall).toMatchObject({ paired: 3, exactMatches: 1 });
    expect(overall.exactMatchRate).toBeCloseTo(1 / 3);
    expect(overall.meanAbsDiff).toBeCloseTo(4 / 3);
  });

  it('rounds for exact match so a QAG fraction can still agree, and counts one-sided scores', () => {
    const turns: TurnScores[] = [
      { perCriterion: { [FAITHFULNESS_EVAL_NAME]: 0.8, [RELEVANCE_EVAL_NAME]: 0.5 }, consolidated: { [FAITHFULNESS_EVAL_NAME]: 0.75, [COHERENCE_EVAL_NAME]: 1 } },
    ];
    const { byCriterion } = computeAgreement(turns);
    expect(byCriterion[FAITHFULNESS_EVAL_NAME]).toMatchObject({ paired: 1, exactMatches: 1 });
    expect(byCriterion[FAITHFULNESS_EVAL_NAME]!.meanAbsDiff).toBeCloseTo(0.2);
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
    expect(estimateTurnTokens(turns[1]!)).toBeGreaterThan(0);
    const estimate = estimateSpend(turns, TEST_PRICING);
    expect(estimate.consolidatedInputTokens).toBe(estimateTurnTokens(turns[0]!) + estimateTurnTokens(turns[1]!));
    expect(estimate.perCriterionInputTokens).toBeGreaterThan(estimate.consolidatedInputTokens * 2);
    expect(estimate.totalUsd).toBeGreaterThan(0);
  });
});
