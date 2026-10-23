import { describe, it, expect } from 'vitest';
import {
  parseProbeArgs,
  fabricatedShare,
  buildVerdictsPrompt,
  METHOD_FLAG,
  LABELS_FLAG,
  type ClaimVerdict,
} from '../judge-hallucination-probe.js';
import { DEFAULT_LABELS_PATH } from '../judge-hallucination-compare.js';
import { CliArgError } from '../cli-args.js';

function verdict(label: ClaimVerdict['label']): ClaimVerdict {
  return { claim: 'tests pass', label, evidence: 'none' };
}

const HALF = 0.5;

describe('parseProbeArgs', () => {
  it.each(['isolated', 'claims'] as const)('accepts --method %s and defaults the labels', (method) => {
    expect(parseProbeArgs([METHOD_FLAG, method])).toEqual({ method, labelsPath: DEFAULT_LABELS_PATH });
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
