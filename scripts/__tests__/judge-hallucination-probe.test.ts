import { describe, it, expect } from 'vitest';
import {
  parseProbeArgs,
  fabricatedShare,
  buildVerdictsPrompt,
  METHOD_FLAG,
  LABELS_FLAG,
  THINKING_FLAG,
  EFFORT_FLAG,
  PROBE_METHODS,
  type ClaimVerdict,
} from '../judge-hallucination-probe.js';
import { DEFAULT_LABELS_PATH } from '../judge-hallucination-compare.js';
import { CliArgError } from '../cli-args.js';
import { LEGACY_HAIKU_MODEL } from '../judge-criteria.js';
import { DEFAULT_JUDGE_SPEC, JUDGE_MODEL_ENV } from '../judge-spec.js';

function verdict(label: ClaimVerdict['label']): ClaimVerdict {
  return { claim: 'tests pass', label, evidence: 'none' };
}

const HALF = 0.5;

describe('parseProbeArgs', () => {
  it.each(PROBE_METHODS)('accepts --method %s, defaulting the labels and the production reasoning settings', (method) => {
    expect(parseProbeArgs([METHOD_FLAG, method], {})).toEqual({ method, labelsPath: DEFAULT_LABELS_PATH, reasoning: {}, judge: DEFAULT_JUDGE_SPEC });
  });

  it('judges with JUDGE_MODEL when it is set, and refuses one it cannot price', () => {
    expect(parseProbeArgs([METHOD_FLAG, 'isolated'], { [JUDGE_MODEL_ENV]: LEGACY_HAIKU_MODEL }).judge.model).toBe(LEGACY_HAIKU_MODEL);
    expect(() => parseProbeArgs([METHOD_FLAG, 'isolated'], { [JUDGE_MODEL_ENV]: 'no-such-model-0' })).toThrow(CliArgError);
  });

  it('takes thinking and effort overrides', () => {
    const args = parseProbeArgs([METHOD_FLAG, 'isolated', THINKING_FLAG, 'adaptive', EFFORT_FLAG, 'medium']);
    expect(args.reasoning).toEqual({ thinking: 'adaptive', effort: 'medium' });
  });

  it.each([[THINKING_FLAG, 'on'], [EFFORT_FLAG, 'extreme']])('rejects %s %s', (flag, value) => {
    expect(() => parseProbeArgs([METHOD_FLAG, 'isolated', flag, value])).toThrow(CliArgError);
  });

  it('takes a labels file', () => {
    expect(parseProbeArgs([METHOD_FLAG, 'claims', LABELS_FLAG, 'run.json']).labelsPath).toBe('run.json');
  });

  it.each([
    ['no method', []],
    ['an unknown method', [METHOD_FLAG, 'qag']],
    ['an unknown flag', [METHOD_FLAG, 'claims', '--label', 'run.json']],
  ])('rejects %s', (_label, argv) => {
    expect(() => parseProbeArgs(argv)).toThrow(CliArgError);
  });
});

describe('fabricatedShare', () => {
  it('is 0 when there are no claims', () => {
    expect(fabricatedShare([])).toBe(0);
  });

  it('counts contradicted and absent claims, not supported ones', () => {
    expect(fabricatedShare([verdict('supported'), verdict('contradicted'), verdict('absent'), verdict('supported')])).toBe(HALF);
  });

  it('is 0 when every claim is supported', () => {
    expect(fabricatedShare([verdict('supported'), verdict('supported')])).toBe(0);
  });
});

describe('buildVerdictsPrompt', () => {
  it('numbers the claims in order after the context', () => {
    const prompt = buildVerdictsPrompt(['first claim', 'second claim'], ['tool said hello']);
    expect(prompt.indexOf('tool said hello')).toBeLessThan(prompt.indexOf('1. first claim'));
    expect(prompt.indexOf('1. first claim')).toBeLessThan(prompt.indexOf('2. second claim'));
  });
});
