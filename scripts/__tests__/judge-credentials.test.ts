import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveJudgeApiKey,
  JUDGE_API_KEY_ENV,
  DEFAULT_API_KEY_ENV,
  JUDGE_API_KEY_ENV_PRECEDENCE,
} from '../judge-credentials.js';

// Placeholders, not credentials: the resolver never inspects the value.
const JUDGE_KEY = 'judge-key-value';
const DEFAULT_KEY = 'default-key-value';

describe('resolveJudgeApiKey', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the judge key when both variables are set', () => {
    const resolved = resolveJudgeApiKey({ [JUDGE_API_KEY_ENV]: JUDGE_KEY, [DEFAULT_API_KEY_ENV]: DEFAULT_KEY });

    expect(resolved).toEqual({ apiKey: JUDGE_KEY, source: JUDGE_API_KEY_ENV });
  });

  it('falls back to the shared default key when the judge key is absent', () => {
    const resolved = resolveJudgeApiKey({ [DEFAULT_API_KEY_ENV]: DEFAULT_KEY });

    expect(resolved).toEqual({ apiKey: DEFAULT_KEY, source: DEFAULT_API_KEY_ENV });
  });

  it('returns undefined when neither variable is set', () => {
    expect(resolveJudgeApiKey({})).toBeUndefined();
  });

  it('treats an empty value as unset', () => {
    const resolved = resolveJudgeApiKey({ [JUDGE_API_KEY_ENV]: '', [DEFAULT_API_KEY_ENV]: DEFAULT_KEY });

    expect(resolved).toEqual({ apiKey: DEFAULT_KEY, source: DEFAULT_API_KEY_ENV });
    expect(resolveJudgeApiKey({ [JUDGE_API_KEY_ENV]: '', [DEFAULT_API_KEY_ENV]: '' })).toBeUndefined();
  });

  it('reads process.env when no environment is given', () => {
    vi.stubEnv(JUDGE_API_KEY_ENV, JUDGE_KEY);

    expect(resolveJudgeApiKey()?.source).toBe(JUDGE_API_KEY_ENV);
  });

  it('names the judge key first in the precedence order', () => {
    expect(JUDGE_API_KEY_ENV_PRECEDENCE).toEqual([JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV]);
  });
});
