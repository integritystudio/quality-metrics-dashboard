/**
 * Which Anthropic key the judge spends against, and where it came from.
 *
 * The pipeline runs under `doppler run --config prd`, whose ANTHROPIC_API_KEY
 * is the organization's shared default key (Console name `alyshia_key`), so
 * judge spend landing on it cannot be told apart from anything else in the
 * Usage and Cost Admin API. LLM_JUDGE_ANTHROPIC_KEY (Console name
 * `llm-judge-key`) exists for exactly that attribution and wins when set; the
 * shared key stays as the fallback so a local run with only ANTHROPIC_API_KEY
 * still works. Callers log the `source` NAME, never the value.
 */

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
