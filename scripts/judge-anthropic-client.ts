/**
 * The one place judge scripts construct an Anthropic client. Every client gets
 * `scriptFetch()`, HTTP/1.1 under a CLI (NODE-FETCH-HTTP2-DEAD-SESSION), unless
 * the caller passes its own `fetch`. The SDK
 * import is dynamic so that a `--dry-run` never loads it.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import { JUDGE_EFFORT, JUDGE_THINKING } from './judge-criteria.js';
import { scriptFetch } from './script-fetch.js';

export async function createJudgeAnthropicClient(options: ClientOptions = {}): Promise<Anthropic> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  return new AnthropicClient({ ...options, fetch: options.fetch ?? scriptFetch() });
}

export const MAX_TOKENS_STOP_REASON = 'max_tokens';

type JsonOutputSchema = Anthropic.Messages.JSONOutputFormat['schema'];

export function jsonSchemaFormat(schema: JsonOutputSchema): Anthropic.Messages.JSONOutputFormat {
  return { type: 'json_schema', schema };
}

export const JUDGE_THINKING_MODES = ['disabled', 'adaptive'] as const;
export type JudgeThinkingMode = typeof JUDGE_THINKING_MODES[number];
export const JUDGE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type JudgeEffortLevel = typeof JUDGE_EFFORT_LEVELS[number];

/** What a probe may vary; production passes none and gets JUDGE_THINKING at JUDGE_EFFORT. */
export type JudgeReasoningSettings = { thinking?: JudgeThinkingMode; effort?: JudgeEffortLevel };

/** Every judge request's thinking and output settings, with the JSON schema as `output_config.format` when given. */
export function judgeRequestSettings(
  schema: JsonOutputSchema | undefined,
  reasoning: JudgeReasoningSettings = {},
): Pick<Anthropic.Messages.MessageCreateParamsNonStreaming, 'thinking' | 'output_config'> {
  return {
    thinking: { type: reasoning.thinking ?? JUDGE_THINKING },
    output_config: { effort: reasoning.effort ?? JUDGE_EFFORT, ...(schema && { format: jsonSchemaFormat(schema) }) },
  };
}

/** A Messages API response's text blocks, joined; thinking and tool blocks are dropped. */
export function responseText(content: readonly Anthropic.Messages.ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
}
