/**
 * isHallucinationIndicator decides which evaluations SessionDetailPage lists as
 * hallucination indicators and whether the session's issues turn critical.
 */
import { describe, expect, it } from 'vitest';
import { isFailedEvaluation, isHallucinationIndicator, type ScoredEvaluation } from '../lib/quality-utils.js';
import { HALLUCINATION_RISK_THRESHOLD, LOW_CONFIDENCE_FAIL_THRESHOLD } from '../lib/constants.js';

/** The dashboard judge's hallucination score for one turn, as the session route returns it (production, 2026-09-22). */
const JUDGE_HALLUCINATION: ScoredEvaluation = { evaluationName: 'hallucination', scoreValue: 0.25 };

const NO_FABRICATION = 0;
const JUST_BELOW = 0.1;
const FAITHFUL = 0.75;
const LOW_SCORE = 0.2;

describe('isHallucinationIndicator', () => {
  it.each([
    ['a judge hallucination score above the threshold', JUDGE_HALLUCINATION],
    ['a hallucination score equal to the threshold', { evaluationName: 'hallucination', scoreValue: HALLUCINATION_RISK_THRESHOLD }],
    ['hallucination_risk above the threshold', { evaluationName: 'hallucination_risk', scoreValue: FAITHFUL }],
    ['a differently cased name', { evaluationName: 'Hallucination', scoreValue: FAITHFUL }],
    ['a failed evaluation with a very low score', { evaluationName: 'tool_correctness', scoreValue: LOW_SCORE, scoreLabel: 'fail' }],
  ] satisfies [string, ScoredEvaluation][])('flags %s', (_label, evaluation) => {
    expect(isHallucinationIndicator(evaluation)).toBe(true);
  });

  it.each([
    ['a hallucination score of 0 (no fabrication found)', { evaluationName: 'hallucination', scoreValue: NO_FABRICATION }],
    ['a hallucination score below the threshold', { evaluationName: 'hallucination', scoreValue: JUST_BELOW }],
    ['a hallucination evaluation with no score (errored)', { evaluationName: 'hallucination' }],
    ['a hallucination evaluation with a null score', { evaluationName: 'hallucination', scoreValue: null }],
    ['a non-finite hallucination score', { evaluationName: 'hallucination', scoreValue: Number.NaN }],
    ['faithfulness, which is higher-is-better', { evaluationName: 'faithfulness', scoreValue: FAITHFUL }],
    ['a name that only contains hallucination', { evaluationName: 'hallucination_check', scoreValue: FAITHFUL }],
    ['a failed evaluation at the low-confidence threshold', { evaluationName: 'tool_correctness', scoreValue: LOW_CONFIDENCE_FAIL_THRESHOLD, scoreLabel: 'fail' }],
    ['a passing evaluation with a low score', { evaluationName: 'relevance', scoreValue: LOW_SCORE, scoreLabel: 'pass' }],
  ] satisfies [string, ScoredEvaluation][])('does not flag %s', (_label, evaluation) => {
    expect(isHallucinationIndicator(evaluation)).toBe(false);
  });
});

describe('isFailedEvaluation', () => {
  it.each([
    ['fail', true],
    ['FAIL', true],
    ['pass', false],
    [undefined, false],
    [null, false],
  ] as const)('reads label %s as failed: %s', (scoreLabel, expected) => {
    expect(isFailedEvaluation({ evaluationName: 'relevance', scoreLabel })).toBe(expected);
  });
});
