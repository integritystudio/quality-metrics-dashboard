import { describe, it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { RELEVANCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, LEGACY_HAIKU_MODEL } from '../judge-criteria.js';
import { DEFAULT_JUDGE_SPEC, JUDGE_MODEL_ENV } from '../judge-spec.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { makeSizedTurn, TEST_PRICING } from './support/fixtures.js';
import { useTempDir } from './support/temp-dir.js';

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
    expect(parseArgs([YES_FLAG], {})).toEqual({ yes: true, referencePath: PRIOR_REFERENCE_PATH, judge: DEFAULT_JUDGE_SPEC });
  });

  it('judges with JUDGE_MODEL when it is set, and refuses one it cannot price', () => {
    expect(parseArgs([YES_FLAG], { [JUDGE_MODEL_ENV]: LEGACY_HAIKU_MODEL }).judge?.model).toBe(LEGACY_HAIKU_MODEL);
    expect(parseArgs([YES_FLAG], { [JUDGE_MODEL_ENV]: 'no-such-model-0' }).error).toMatch(/no pricing row/);
  });

  it('takes an explicit reference path', () => {
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG, 'x.json']).referencePath).toBe('x.json');
  });

  it('refuses a reference flag with no path after it', () => {
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG]).error).toMatch('needs a value');
  });
});

describe('reference input files', () => {
  const dir = useTempDir('hal-eval-');

  it('rejects a file without reference scores', () => {
    const path = join(dir(), 'agreement.json');
    writeFileSync(path, JSON.stringify({ turns: [{ sessionId: 's', timestamp: 't' }] }));
    expect(() => readPriorReference(path)).toThrow('not a judge-quality results file');
  });
});

describe('mergeReference', () => {
  const prior = { [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5, [HALLUCINATION_EVAL_NAME]: 0.5 };

  it('replaces the inverted hallucination with the direct verdict and keeps the rest', () => {
    expect(mergeReference(prior, 0)).toEqual({ [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5, [HALLUCINATION_EVAL_NAME]: 0 });
  });

  it('drops the inverted value when there is no direct verdict, rather than keeping it', () => {
    expect(mergeReference(prior, undefined)).toEqual({ [RELEVANCE_EVAL_NAME]: 0.75, [FAITHFULNESS_EVAL_NAME]: 0.5 });
  });
});

describe('countComplements', () => {
  it('counts turns whose faithfulness and hallucination sum to 1, over turns that have both', () => {
    const count = countComplements([
      { [FAITHFULNESS_EVAL_NAME]: 0.75, [HALLUCINATION_EVAL_NAME]: 0.25 },
      { [FAITHFULNESS_EVAL_NAME]: 0.5, [HALLUCINATION_EVAL_NAME]: 0.5 },
      { [FAITHFULNESS_EVAL_NAME]: 0.25, [HALLUCINATION_EVAL_NAME]: 0 },
      { [FAITHFULNESS_EVAL_NAME]: 1 },
      {},
    ]);
    expect(count).toEqual({ paired: 3, sumToOne: 2 });
  });
});

describe('closestConfiguration', () => {
  it('picks the configuration with the lowest MAE for a criterion', () => {
    const verdict = closestConfiguration({
      perCriterion: summary({ [HALLUCINATION_EVAL_NAME]: 1.2 }),
      consolidated: summary({ [HALLUCINATION_EVAL_NAME]: 0.4 }),
      consolidatedDirect: summary({ [HALLUCINATION_EVAL_NAME]: 0.9 }),
    });

    expect(verdict[HALLUCINATION_EVAL_NAME]).toBe('consolidated');
  });

  it('calls a tie when the configurations share the lowest MAE', () => {
    const verdict = closestConfiguration({
      perCriterion: summary({ [RELEVANCE_EVAL_NAME]: 0.5 }),
      consolidated: summary({ [RELEVANCE_EVAL_NAME]: 0.5 }),
      consolidatedDirect: summary({ [RELEVANCE_EVAL_NAME]: 0.5 }),
    });

    expect(verdict[RELEVANCE_EVAL_NAME]).toBe('tie');
  });

  it('calls a tie when only one configuration is paired with the reference', () => {
    const verdict = closestConfiguration({
      perCriterion: summary({ only: 0.1 }),
      consolidated: summary({ only: null }),
      consolidatedDirect: summary({}),
    });

    expect(verdict.only).toBe('tie');
  });
});

describe('estimateRunSpend', () => {
  const SHORT_TOOL_RESULT_CHARS = 400;
  const toolTurn = () => makeSizedTurn({ toolResults: ['r'.repeat(SHORT_TOOL_RESULT_CHARS)] });

  it('prices no reference call for a turn without tools', () => {
    const spend = estimateRunSpend([makeSizedTurn()], TEST_PRICING, TEST_PRICING);

    expect(spend.referenceCalls).toBe(0);
    expect(spend.referenceUsd).toBe(0);
  });

  it('prices one reference call per tool turn', () => {
    const one = estimateRunSpend([makeSizedTurn(), toolTurn()], TEST_PRICING, TEST_PRICING);
    const two = estimateRunSpend([makeSizedTurn(), toolTurn(), toolTurn()], TEST_PRICING, TEST_PRICING);

    expect(one.referenceCalls).toBe(1);
    expect(two.referenceCalls).toBe(2);
    expect(two.referenceUsd).toBe(2 * one.referenceUsd);
  });

  it('totals the Haiku and reference spend', () => {
    const spend = estimateRunSpend([toolTurn()], TEST_PRICING, TEST_PRICING);

    expect(spend.totalUsd).toBe(spend.judgeUsd + spend.referenceUsd);
  });
});
