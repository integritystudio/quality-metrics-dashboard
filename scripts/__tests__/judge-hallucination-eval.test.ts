import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseArgs,
  readPriorReference,
  mergeReference,
  countComplements,
  closestConfiguration,
  estimateRunSpend,
  REFERENCE_FLAG,
  PRIOR_REFERENCE_PATH,
} from '../judge-hallucination-eval.js';
import { YES_FLAG } from '../one-shot-eval.js';
import type { ReferenceSummary } from '../judge-quality-eval.js';
import { RELEVANCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME } from '../judge-criteria.js';
import { makeSizedTurn, TEST_PRICING } from './support/fixtures.js';

const HALLUCINATION = 'hallucination';

function summary(maes: Record<string, number | null>): ReferenceSummary {
  const distance = (mae: number | null) => ({
    paired: mae === null ? 0 : 1,
    exactMatchRate: null,
    meanAbsDiff: mae,
    meanSignedDiff: null,
    configOnly: 0,
    referenceOnly: 0,
  });
  return {
    byCriterion: Object.fromEntries(Object.entries(maes).map(([name, mae]) => [name, distance(mae)])),
    overall: distance(null),
  };
}

describe('parseArgs', () => {
  it('defaults the reference to the JCP4 results file', () => {
    expect(parseArgs([YES_FLAG])).toEqual({ yes: true, referencePath: PRIOR_REFERENCE_PATH });
  });

  it('takes an explicit reference path and refuses a missing one', () => {
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG, 'x.json']).referencePath).toBe('x.json');
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG]).error).toMatch('needs a value');
  });
});

describe('reference input files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hal-eval-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a file without reference scores', () => {
    const path = join(dir, 'agreement.json');
    writeFileSync(path, JSON.stringify({ turns: [{ sessionId: 's', timestamp: 't' }] }));
    expect(() => readPriorReference(path)).toThrow('not a judge-quality results file');
  });
});

describe('mergeReference', () => {
  const prior = { [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5, [HALLUCINATION]: 0.5 };

  it('replaces the inverted hallucination with the direct verdict and keeps the rest', () => {
    expect(mergeReference(prior, 0)).toEqual({ [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5, [HALLUCINATION]: 0 });
  });

  it('drops the inverted value when there is no direct verdict, rather than keeping it', () => {
    expect(mergeReference(prior, undefined)).toEqual({ [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5 });
  });
});

describe('countComplements', () => {
  it('counts turns whose faithfulness and hallucination sum to 1, over turns that have both', () => {
    const count = countComplements([
      { [FAITHFULNESS_EVAL_NAME]: 0.75, [HALLUCINATION]: 0.25 },
      { [FAITHFULNESS_EVAL_NAME]: 0.25, [HALLUCINATION]: 0 },
      { [FAITHFULNESS_EVAL_NAME]: 1 },
      {},
    ]);
    expect(count).toEqual({ paired: 2, sumToOne: 1 });
  });
});

describe('closestConfiguration', () => {
  it('picks the lowest MAE per criterion and ties when equal or only one configuration is paired', () => {
    const verdict = closestConfiguration({
      perCriterion: summary({ [HALLUCINATION]: 1.2, [RELEVANCE_EVAL_NAME]: 0.5, only: 0.1 }),
      consolidated: summary({ [HALLUCINATION]: 0.9, [RELEVANCE_EVAL_NAME]: 0.5, only: null }),
      consolidatedDirect: summary({ [HALLUCINATION]: 0.4, [RELEVANCE_EVAL_NAME]: 0.5 }),
    });
    expect(verdict).toEqual({ [HALLUCINATION]: 'consolidatedDirect', [RELEVANCE_EVAL_NAME]: 'tie', only: 'tie' });
  });
});

describe('estimateRunSpend', () => {
  it('prices one reference call per tool turn and none for a turn without tools', () => {
    const noTools = estimateRunSpend([makeSizedTurn()], TEST_PRICING, TEST_PRICING);
    expect(noTools.referenceCalls).toBe(0);
    expect(noTools.referenceUsd).toBe(0);

    const withTools = estimateRunSpend([makeSizedTurn(), makeSizedTurn({ toolResults: ['r'.repeat(400)] })], TEST_PRICING, TEST_PRICING);
    expect(withTools.referenceCalls).toBe(1);
    expect(withTools.referenceUsd).toBeGreaterThan(0);
    expect(withTools.totalUsd).toBeCloseTo(withTools.haikuUsd + withTools.referenceUsd);
  });
});
