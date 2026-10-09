import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  resolveJudgeApiKey,
  JUDGE_API_KEY_ENV,
  DEFAULT_API_KEY_ENV,
  JUDGE_API_KEY_ENV_PRECEDENCE,
  pickWorkingJudgeApiKey,
  JudgeProbeSetupError,
  resolveWorkingJudgeApiKey,
  resetWorkingJudgeApiKeyForTests,
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

describe('pickWorkingJudgeApiKey', () => {
  const BOTH = { [JUDGE_API_KEY_ENV]: JUDGE_KEY, [DEFAULT_API_KEY_ENV]: DEFAULT_KEY };
  const rejection = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the judge key when Anthropic accepts it', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    expect(await pickWorkingJudgeApiKey(BOTH, probe)).toEqual({ apiKey: JUDGE_KEY, source: JUDGE_API_KEY_ENV });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('falls back to the shared key when the judge key gets %i', async status => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const probe = vi.fn((key: string) =>
      key === JUDGE_KEY ? Promise.reject(rejection(status)) : Promise.resolve());

    expect(await pickWorkingJudgeApiKey(BOTH, probe)).toEqual({ apiKey: DEFAULT_KEY, source: DEFAULT_API_KEY_ENV });
  });

  it('keeps the judge key on a failure that is not a credential rejection', async () => {
    const probe = vi.fn().mockRejectedValue(rejection(503));

    expect(await pickWorkingJudgeApiKey(BOTH, probe)).toEqual({ apiKey: JUDGE_KEY, source: JUDGE_API_KEY_ENV });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('throws when the probe could not be set up, instead of accepting the key', async () => {
    const probe = vi.fn().mockRejectedValue(new JudgeProbeSetupError(new Error('sdk missing')));

    await expect(pickWorkingJudgeApiKey(BOTH, probe)).rejects.toBeInstanceOf(JudgeProbeSetupError);
  });

  it('returns undefined when every set key is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const probe = vi.fn().mockRejectedValue(rejection(401));

    expect(await pickWorkingJudgeApiKey(BOTH, probe)).toBeUndefined();
  });

  it('does not probe a key that is unset', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);

    expect(await pickWorkingJudgeApiKey({ [DEFAULT_API_KEY_ENV]: DEFAULT_KEY }, probe))
      .toEqual({ apiKey: DEFAULT_KEY, source: DEFAULT_API_KEY_ENV });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('resolveWorkingJudgeApiKey', () => {
  afterEach(() => {
    resetWorkingJudgeApiKeyForTests();
    vi.unstubAllEnvs();
  });

  it('probes once per process however many callers ask', async () => {
    vi.stubEnv(JUDGE_API_KEY_ENV, JUDGE_KEY);
    vi.stubEnv(DEFAULT_API_KEY_ENV, DEFAULT_KEY);
    const probe = vi.fn().mockResolvedValue(undefined);

    const [first, second] = [await resolveWorkingJudgeApiKey(probe), await resolveWorkingJudgeApiKey(probe)];

    expect(first).toBe(second);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});
