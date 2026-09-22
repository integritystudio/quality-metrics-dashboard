import { describe, it, expect } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseArgs,
  resolveApiKey,
  refusalReason,
  listResultsFiles,
  resultsFilePath,
  toFivePointScale,
  computeAgreement,
  countMissing,
  usageToUsd,
  createUsageTotals,
  addUsage,
  estimateTurnTokens,
  estimateSpend,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  YES_FLAG,
  LIMIT_FLAG,
  PRIMARY_KEY_ENV,
  FALLBACK_KEY_ENV,
  MARKER_FILENAME,
  RESULTS_PREFIX,
  RESULTS_SUFFIX,
  type TurnScores,
  type TurnOutcome,
} from '../judge-agreement.js';
import { RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, type Turn } from '../judge-evaluations.js';

const PRICING = { input: 1.0, output: 5.0, provider: 'anthropic' } as const;
const ONE_MILLION = 1_000_000;

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-02-09T01:11:15.525Z',
    userText: 'Fix the login bug',
    assistantText: 'I found the issue in auth.ts and fixed it.',
    toolResults: [],
    ...overrides,
  };
}

describe('parseArgs', () => {
  it('requires --yes', () => {
    expect(parseArgs([]).error).toMatch(new RegExp(`${YES_FLAG} is required`));
    expect(parseArgs([YES_FLAG]).error).toBeUndefined();
  });

  it('defaults the limit and accepts an explicit one', () => {
    expect(parseArgs([YES_FLAG]).limit).toBe(DEFAULT_LIMIT);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, '5']).limit).toBe(5);
  });

  it('refuses a limit above the hard maximum or not a positive integer', () => {
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, String(MAX_LIMIT + 1)]).error).toMatch(/hard maximum/);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, '0']).error).toMatch(/positive integer/);
    expect(parseArgs([YES_FLAG, LIMIT_FLAG, 'ten']).error).toMatch(/positive integer/);
  });

  it('has no --force flag', () => {
    expect(parseArgs([YES_FLAG, '--force']).error).toMatch(/Unknown argument: --force/);
  });
});

describe('resolveApiKey', () => {
  it('prefers the judge key and falls back to the general one, naming the source only', () => {
    expect(resolveApiKey({ [PRIMARY_KEY_ENV]: 'a', [FALLBACK_KEY_ENV]: 'b' })).toEqual({ key: 'a', source: PRIMARY_KEY_ENV });
    expect(resolveApiKey({ [FALLBACK_KEY_ENV]: 'b' })).toEqual({ key: 'b', source: FALLBACK_KEY_ENV });
    expect(resolveApiKey({})).toBeUndefined();
  });
});

describe('refusalReason', () => {
  const dir = join(tmpdir(), `judge-agreement-test-${process.pid}-${Date.now()}`);

  it('allows a fresh docs dir, refuses a marker, refuses an existing results file', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    expect(refusalReason(dir)).toBeUndefined();

    const results = resultsFilePath(dir, new Date('2026-09-21T00:00:00Z'));
    expect(results).toBe(join(dir, `${RESULTS_PREFIX}2026-09-21${RESULTS_SUFFIX}`));
    writeFileSync(results, '{}');
    expect(listResultsFiles(dir)).toEqual([`${RESULTS_PREFIX}2026-09-21${RESULTS_SUFFIX}`]);
    expect(refusalReason(dir)).toMatch(/results already exist/);

    writeFileSync(join(dir, MARKER_FILENAME), '{}');
    expect(refusalReason(dir)).toMatch(/marker exists/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('agreement math', () => {
  it('maps 0-1 back onto the 1-5 scale', () => {
    expect(toFivePointScale(0)).toBe(1);
    expect(toFivePointScale(0.75)).toBe(4);
    expect(toFivePointScale(1)).toBe(5);
  });

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

describe('usage and cost', () => {
  it('prices input and output tokens per million at the model rate', () => {
    const usage = { inputTokens: ONE_MILLION, outputTokens: ONE_MILLION / 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    expect(usageToUsd(usage, PRICING)).toBeCloseTo(2);
  });

  it('accumulates usage and call counts', () => {
    const totals = createUsageTotals();
    addUsage(totals, { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 1, cacheReadInputTokens: 0 });
    addUsage(totals, { inputTokens: 5, outputTokens: 3, cacheCreationInputTokens: 0, cacheReadInputTokens: 4 });
    expect(totals).toEqual({ calls: 2, inputTokens: 15, outputTokens: 5, cacheCreationInputTokens: 1, cacheReadInputTokens: 4 });
  });

  it('estimates per-criterion input as a multiple of the consolidated input', () => {
    const turns = [makeTurn({ toolResults: ['x'.repeat(4000)] }), makeTurn()];
    expect(estimateTurnTokens(turns[1]!)).toBeGreaterThan(0);
    const estimate = estimateSpend(turns, PRICING);
    expect(estimate.consolidatedInputTokens).toBe(estimateTurnTokens(turns[0]!) + estimateTurnTokens(turns[1]!));
    expect(estimate.perCriterionInputTokens).toBeGreaterThan(estimate.consolidatedInputTokens * 2);
    expect(estimate.totalUsd).toBeGreaterThan(0);
  });
});
