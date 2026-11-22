import { describe, it, expect } from 'vitest';

import { CliArgError } from '../cli-args.js';
import { HAIKU_MODEL, LEGACY_HAIKU_MODEL } from '../judge-criteria.js';
import { DEFAULT_JUDGE_SPEC, JUDGE_MODEL_ENV, JUDGE_PROVIDER_ENV, resolveJudgeSpec } from '../judge-spec.js';

const UNPRICED_MODEL = 'no-such-model-0';
/** Priced only through the family-prefix fallback, at claude-haiku-5-5's rate. */
const FAMILY_TYPO_MODEL = `${HAIKU_MODEL}-x`;
/** An OpenAI row in MODEL_PRICING. */
const OTHER_PROVIDER_MODEL = 'gpt-5.5';

describe('resolveJudgeSpec', () => {
  it('is the default spec when nothing names a judge', () => {
    expect(resolveJudgeSpec({ cli: {}, env: {}, batch: false })).toEqual(DEFAULT_JUDGE_SPEC);
  });

  it('takes its mode from --batch', () => {
    expect(resolveJudgeSpec({ cli: {}, env: {}, batch: true }).mode).toBe('batch');
  });

  it('prefers the flag over the environment, and the environment over the default', () => {
    const env = { [JUDGE_MODEL_ENV]: LEGACY_HAIKU_MODEL };

    expect(resolveJudgeSpec({ cli: {}, env, batch: false }).model).toBe(LEGACY_HAIKU_MODEL);
    expect(resolveJudgeSpec({ cli: { model: HAIKU_MODEL }, env, batch: false }).model).toBe(HAIKU_MODEL);
  });

  it('treats an empty variable as unset, as Doppler passes an emptied secret through', () => {
    const env = { [JUDGE_MODEL_ENV]: '', [JUDGE_PROVIDER_ENV]: '' };

    expect(resolveJudgeSpec({ cli: {}, env, batch: false })).toEqual(DEFAULT_JUDGE_SPEC);
  });

  it('refuses a provider with no adapter before anything is spent', () => {
    expect(() => resolveJudgeSpec({ cli: { provider: 'workers-ai' }, env: {}, batch: false })).toThrow(CliArgError);
    expect(() => resolveJudgeSpec({ cli: {}, env: { [JUDGE_PROVIDER_ENV]: 'openai' }, batch: false })).toThrow(/not supported/);
  });

  it('refuses a model it cannot price, rather than reporting the run at $0', () => {
    expect(() => resolveJudgeSpec({ cli: { model: UNPRICED_MODEL }, env: {}, batch: false })).toThrow(CliArgError);
  });

  it('refuses a model priced only by its family, so a typo is not priced at the family rate', () => {
    expect(() => resolveJudgeSpec({ cli: { model: FAMILY_TYPO_MODEL }, env: {}, batch: false })).toThrow(/no pricing row of its own/);
  });

  it('refuses a model another provider prices, which every call to this provider would fail', () => {
    expect(() => resolveJudgeSpec({ cli: { model: OTHER_PROVIDER_MODEL }, env: {}, batch: false })).toThrow(/priced for openai, not anthropic/);
  });
});
