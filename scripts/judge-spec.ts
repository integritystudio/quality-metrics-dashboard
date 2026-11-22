/**
 * Which judge scores a run, end to end: the value every provider, dedup key and
 * record reads in place of a hard-coded model (docs/roadmap/judge-model-tiers.md
 * § Judge spec and resolution, Phase 0).
 */

import { listEffectiveModels } from '../../src/lib/cost/pricing-cache.js';
import { CliArgError } from './cli-args.js';
import { HAIKU_MODEL } from './judge-criteria.js';

/** Providers a record may name. */
export const JUDGE_PROVIDERS = ['anthropic', 'workers-ai'] as const;
export type JudgeProvider = typeof JUDGE_PROVIDERS[number];

/**
 * Providers this CLI has an adapter for. `workers-ai` runs only behind the judge
 * route (the parent's `services/obtool-judge`); the OpenAI-compatible adapter
 * that would run it here is Phase 1.
 */
const CLI_JUDGE_PROVIDERS: readonly JudgeProvider[] = ['anthropic'];

/** Workers AI names every model under this prefix. */
const WORKERS_AI_MODEL_PREFIX = '@cf/';

/** `specified`: the org names the judge and runs it with its own key. `hosted` is Phase 3. */
export const JUDGE_TIERS = ['hosted', 'specified'] as const;
export type JudgeTier = typeof JUDGE_TIERS[number];

export const JUDGE_MODES = ['sync', 'batch'] as const;
export type JudgeMode = typeof JUDGE_MODES[number];

/**
 * Version of the rubric and output schema. Bump it on any change to a criterion's
 * text, the prompt templates or the verdict schema, so rows from either side of
 * the change can be segmented.
 */
export const JUDGE_PROMPT_VERSION = '1';

export const JUDGE_PROVIDER_ENV = 'JUDGE_PROVIDER';
export const JUDGE_MODEL_ENV = 'JUDGE_MODEL';

export type JudgeSpec = {
  tier: JudgeTier;
  provider: JudgeProvider;
  /** Exact pinned id, as the provider names it. */
  model: string;
  promptVersion: string;
  mode: JudgeMode;
}

/** The judge every path used before the spec existed: Haiku, run here with the org's own key. */
export const DEFAULT_JUDGE_SPEC: JudgeSpec = {
  tier: 'specified',
  provider: 'anthropic',
  model: HAIKU_MODEL,
  promptVersion: JUDGE_PROMPT_VERSION,
  mode: 'sync',
};

/** A variable's value, with '' read as unset: Doppler passes an emptied secret through as ''. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  return value === '' ? undefined : value;
}

function isCliJudgeProvider(value: string): value is JudgeProvider {
  return (CLI_JUDGE_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Refuse a model the judge could not run or price exactly: one with no pricing row
 * of its own (the family-prefix fallback would price a typo at its family's rate)
 * or one whose row names another provider, which that provider's API would refuse
 * on every call.
 */
function assertPricedForProvider(model: string, provider: JudgeProvider): void {
  const row = listEffectiveModels().find(entry => entry.model === model);
  if (!row) throw new CliArgError(`judge model "${model}" has no pricing row of its own`);
  if (row.provider !== provider) {
    throw new CliArgError(`judge model "${model}" is priced for ${row.provider}, not ${provider}`);
  }
}

export type JudgeSpecInputs = {
  /** `--judge-provider` / `--judge-model`, which win over the environment. */
  cli: { provider?: string | undefined; model?: string | undefined };
  env?: NodeJS.ProcessEnv;
  batch: boolean;
}

/**
 * The run's judge, most explicit source first: flag, then environment, then
 * the default. A provider without an adapter, or a model without an exact pricing
 * row for that provider, is refused here, before anything is spent.
 */
export function resolveJudgeSpec({ cli, env = process.env, batch }: JudgeSpecInputs): JudgeSpec {
  const provider = cli.provider ?? envValue(env, JUDGE_PROVIDER_ENV) ?? DEFAULT_JUDGE_SPEC.provider;
  if (!isCliJudgeProvider(provider)) {
    throw new CliArgError(`judge provider "${provider}" is not supported (supported: ${CLI_JUDGE_PROVIDERS.join(', ')})`);
  }
  const model = cli.model ?? envValue(env, JUDGE_MODEL_ENV) ?? DEFAULT_JUDGE_SPEC.model;
  assertPricedForProvider(model, provider);
  return { ...DEFAULT_JUDGE_SPEC, provider, model, mode: batch ? 'batch' : 'sync' };
}

/**
 * The judge a batch through the judge route is: the hosted open-weight model on
 * Workers AI, or the org's named Claude model on the key the route holds for it.
 * A model without an exact pricing row for its provider is refused, as in
 * `resolveJudgeSpec`.
 */
export function routedJudgeSpec(model: string): JudgeSpec {
  const hosted = model.startsWith(WORKERS_AI_MODEL_PREFIX);
  const provider: JudgeProvider = hosted ? 'workers-ai' : DEFAULT_JUDGE_SPEC.provider;
  assertPricedForProvider(model, provider);
  return {
    tier: hosted ? 'hosted' : DEFAULT_JUDGE_SPEC.tier,
    provider,
    model,
    promptVersion: JUDGE_PROMPT_VERSION,
    mode: 'batch',
  };
}
