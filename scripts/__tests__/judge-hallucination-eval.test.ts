import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseArgs,
  refusalReason,
  readPriorReference,
  mergeReference,
  countComplements,
  closestConfiguration,
  estimateRunSpend,
  YES_FLAG,
  REFERENCE_FLAG,
  PRIOR_REFERENCE_PATH,
  MARKER_FILENAME,
  RESULTS_PREFIX,
} from '../judge-hallucination-eval.js';
import type { ReferenceSummary } from '../judge-quality-eval.js';
import { RELEVANCE_EVAL_NAME, FAITHFULNESS_EVAL_NAME, type Turn } from '../judge-evaluations.js';

const HALLUCINATION = 'hallucination';
const PRICING = { input: 1.0, output: 5.0, provider: 'anthropic' } as const;

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-02-09T01:11:15.525Z',
    userText: 'u'.repeat(400),
    assistantText: 'a'.repeat(800),
    toolResults: [],
    ...overrides,
  };
}

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
  it('requires --yes and defaults the reference to the JCP4 results file', () => {
    expect(parseArgs([]).error).toMatch(YES_FLAG);
    expect(parseArgs([YES_FLAG])).toEqual({ yes: true, referencePath: PRIOR_REFERENCE_PATH });
  });

  it('takes an explicit reference path and refuses a missing or unknown one', () => {
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG, 'x.json']).referencePath).toBe('x.json');
    expect(parseArgs([YES_FLAG, REFERENCE_FLAG]).error).toMatch('needs a path');
    expect(parseArgs([YES_FLAG, '--force']).error).toMatch('Unknown argument');
  });
});

describe('run-once files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hal-eval-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allows a run in an empty directory, and is not blocked by the JCP4 results file', () => {
    writeFileSync(join(dir, 'judge-quality-2026-09-22.json'), '{}');
    expect(refusalReason(dir)).toBeUndefined();
  });

  it('refuses while its own marker or results file exists', () => {
    writeFileSync(join(dir, MARKER_FILENAME), '{}');
    expect(refusalReason(dir)).toMatch('marker exists');
    rmSync(join(dir, MARKER_FILENAME));
    writeFileSync(join(dir, `${RESULTS_PREFIX}2026-09-23.json`), '{}');
    expect(refusalReason(dir)).toMatch('results already exist');
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
    const noTools = estimateRunSpend([makeTurn()], PRICING, PRICING);
    expect(noTools.referenceCalls).toBe(0);
    expect(noTools.referenceUsd).toBe(0);

    const withTools = estimateRunSpend([makeTurn(), makeTurn({ toolResults: ['r'.repeat(400)] })], PRICING, PRICING);
    expect(withTools.referenceCalls).toBe(1);
    expect(withTools.referenceUsd).toBeGreaterThan(0);
    expect(withTools.totalUsd).toBeCloseTo(withTools.haikuUsd + withTools.referenceUsd);
  });
});
