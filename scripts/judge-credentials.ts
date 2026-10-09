/**
 * Which Anthropic key the judge spends against, and where it came from.
 *
 * The pipeline runs under `doppler run --config prd`, whose ANTHROPIC_API_KEY
 * is the organization's shared default key (Console name `alyshia_key`), so
 * judge spend landing on it cannot be told apart from anything else in the
 * Usage and Cost Admin API. LLM_JUDGE_ANTHROPIC_KEY (Console name
 * `llm-judge-key`) exists for exactly that attribution and wins when set; the
 * shared key stays as the fallback so a local run with only ANTHROPIC_API_KEY
 * still works. A judge key that is set but rejected (revoked, rotated away) also
 * falls back, at the cost of that attribution; `resolveWorkingJudgeApiKey` logs
 * it. Callers log the `source` NAME, never the value.
 */

import { createJudgeAnthropicClient } from './judge-anthropic-client.js';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** Purpose-built judge key — preferred. */
export const JUDGE_API_KEY_ENV = 'LLM_JUDGE_ANTHROPIC_KEY';
/** The organization's shared default key — fallback. */
export const DEFAULT_API_KEY_ENV = 'ANTHROPIC_API_KEY';
/** First variable that is set and non-empty wins. */
export const JUDGE_API_KEY_ENV_PRECEDENCE = [JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV] as const;

export type JudgeApiKeySource = (typeof JUDGE_API_KEY_ENV_PRECEDENCE)[number];

export interface JudgeApiKey {
  apiKey: string;
  /** Environment variable NAME the key was read from — safe to log. */
  source: JudgeApiKeySource;
}

/**
 * The key to hand `new Anthropic({ apiKey })`, or `undefined` when neither
 * variable is set. An empty value counts as unset: Doppler passes an emptied
 * secret through as '', and the SDK would reject it later with a less useful
 * message than the caller's guard gives.
 */
export function resolveJudgeApiKey(env: NodeJS.ProcessEnv = process.env): JudgeApiKey | undefined {
  for (const source of JUDGE_API_KEY_ENV_PRECEDENCE) {
    const apiKey = env[source];
    if (apiKey) return { apiKey, source };
  }
  return undefined;
}

/** Resolves when Anthropic accepts the key; rejects with the SDK's error otherwise. */
export type JudgeKeyProbe = (apiKey: string) => Promise<void>;

const probeWithModelsList: JudgeKeyProbe = async apiKey => {
  const client = await createJudgeAnthropicClient({ apiKey, maxRetries: 0 });
  await client.models.list({ limit: 1 });
};

function isCredentialRejection(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN;
}

/**
 * The first key in precedence order that Anthropic accepts. Only a 401/403
 * rejects a candidate: a network or 5xx failure says nothing about the key, so
 * that candidate is kept and the judge's own retry handling deals with it.
 * Returns undefined when every set key is rejected, or none is set.
 */
export async function pickWorkingJudgeApiKey(
  env: NodeJS.ProcessEnv,
  probe: JudgeKeyProbe,
): Promise<JudgeApiKey | undefined> {
  for (const source of JUDGE_API_KEY_ENV_PRECEDENCE) {
    const apiKey = env[source];
    if (!apiKey) continue;
    try {
      await probe(apiKey);
    } catch (error) {
      if (!isCredentialRejection(error)) return { apiKey, source };
      console.warn(`[judge] ${source} was rejected by Anthropic; trying the next key`);
      continue;
    }
    if (source !== JUDGE_API_KEY_ENV_PRECEDENCE[0]) {
      console.warn(`[judge] using ${source}: its spend is not attributed to ${JUDGE_API_KEY_ENV}`);
    }
    return { apiKey, source };
  }
  return undefined;
}

let workingKey: Promise<JudgeApiKey | undefined> | undefined;

/** `pickWorkingJudgeApiKey` on process.env, probed once per process. */
export function resolveWorkingJudgeApiKey(): Promise<JudgeApiKey | undefined> {
  workingKey ??= pickWorkingJudgeApiKey(process.env, probeWithModelsList);
  return workingKey;
}
