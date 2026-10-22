import { describe, it, expect } from 'vitest';
import { compareToLabels, parseCompareArgs, CANDIDATE_FLAG, LABELS_FLAG, DEFAULT_LABELS_PATH } from '../judge-hallucination-compare.js';
import { CliArgError } from '../cli-args.js';
import type { HallucinationTurn } from '../judge-hallucination-eval.js';

const HALLUCINATION = 'hallucination';
const CLEAN = 0;
const GRADE_4 = 0.25;
const GRADE_2 = 0.75;
const CLEAN_TO_GRADE_2_STEPS = 3;
const CLOSE_TO_DIGITS = 6;
const GRADE_FOUR = 4;

function turn(sessionId: string, reference: number | undefined, scores: Partial<Record<'perCriterion' | 'consolidated' | 'consolidatedDirect', number>> = {}): HallucinationTurn {
  const pick = (score: number | undefined) => (score === undefined ? {} : { [HALLUCINATION]: score });
  return {
    sessionId,
    timestamp: '2026-08-28T17:38:56.941Z',
    hasTools: true,
    expected: [HALLUCINATION],
    reference: pick(reference),
    perCriterion: pick(scores.perCriterion),
    consolidated: pick(scores.consolidated),
    consolidatedDirect: pick(scores.consolidatedDirect),
  };
}

describe('compareToLabels', () => {
  it('scores the candidate against the labels file, not against its own reference', () => {
    const labels = [turn('a', GRADE_4)];
    const candidate = [turn('a', CLEAN, { consolidatedDirect: GRADE_4 })];

    const result = compareToLabels(candidate, labels);

    expect(result.byConfiguration.consolidatedDirect.mae).toBe(0);
  });

  it('reports MAE in grade steps', () => {
    const labels = [turn('a', CLEAN)];
    const candidate = [turn('a', CLEAN, { consolidated: GRADE_2 })];

    expect(compareToLabels(candidate, labels).byConfiguration.consolidated.mae).toBe(CLEAN_TO_GRADE_2_STEPS);
  });

  it('counts recall on flagged labels and specificity on clean ones', () => {
    const labels = [turn('flagged-hit', GRADE_4), turn('flagged-miss', GRADE_2), turn('clean-hit', CLEAN), turn('clean-miss', CLEAN)];
    const candidate = [
      turn('flagged-hit', CLEAN, { perCriterion: GRADE_2 }),
      turn('flagged-miss', CLEAN, { perCriterion: CLEAN }),
      turn('clean-hit', CLEAN, { perCriterion: CLEAN }),
      turn('clean-miss', CLEAN, { perCriterion: GRADE_4 }),
    ];

    const { recall, specificity } = compareToLabels(candidate, labels).byConfiguration.perCriterion;

    expect(recall).toEqual({ hits: 1, of: 2 });
    expect(specificity).toEqual({ hits: 1, of: 2 });
  });

  it('pairs only turns present in both files with a hallucination score on each side', () => {
    const labels = [turn('both', CLEAN), turn('labels-only', CLEAN), turn('no-label', undefined)];
    const candidate = [turn('both', CLEAN, { consolidated: CLEAN }), turn('no-label', CLEAN, { consolidated: CLEAN }), turn('candidate-only', CLEAN, { consolidated: CLEAN })];

    const result = compareToLabels(candidate, labels);

    expect(result.labelled).toBe(2);
    expect(result.byConfiguration.consolidated.paired).toBe(1);
    expect(result.byConfiguration.perCriterion).toEqual({ paired: 0, mae: null, recall: { hits: 0, of: 0 }, specificity: { hits: 0, of: 0 } });
  });

  it('names the constant grade closest to the labels', () => {
    const labels = [turn('a', GRADE_4), turn('b', GRADE_4), turn('c', CLEAN)];
    const oneGradeStepSpreadOverLabels = 1 / labels.length;

    expect(compareToLabels([], labels).bestConstant).toEqual({ grade: GRADE_FOUR, mae: expect.closeTo(oneGradeStepSpreadOverLabels, CLOSE_TO_DIGITS) as number });
  });
});

describe('parseCompareArgs', () => {
  it('defaults the labels to the archived 09-25 results when only the candidate is given', () => {
    expect(parseCompareArgs([CANDIDATE_FLAG, 'new.json'])).toEqual({ candidatePath: 'new.json', labelsPath: DEFAULT_LABELS_PATH });
  });

  it('reads both paths in either order', () => {
    expect(parseCompareArgs([LABELS_FLAG, 'old.json', CANDIDATE_FLAG, 'new.json'])).toEqual({ candidatePath: 'new.json', labelsPath: 'old.json' });
  });

  it.each([
    ['no candidate', [LABELS_FLAG, 'old.json'], /--candidate/],
    ['a misspelled flag', [CANDIDATE_FLAG, 'new.json', '--label', 'old.json'], /Unknown argument: --label/],
    ['a bare path', ['new.json'], /Unknown argument: new.json/],
    ['a flag with no value', [CANDIDATE_FLAG, 'new.json', LABELS_FLAG], /--labels needs a value/],
  ])('rejects %s', (_label, argv, message) => {
    expect(() => parseCompareArgs(argv)).toThrow(CliArgError);
    expect(() => parseCompareArgs(argv)).toThrow(message);
  });
});
