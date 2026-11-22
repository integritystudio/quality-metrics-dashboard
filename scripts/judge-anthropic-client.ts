/**
 * The one place judge scripts construct an Anthropic client. Every client gets
 * the parent's HTTP/1.1 `http1Fetch` (NODE-FETCH-HTTP2-DEAD-SESSION). The SDK
 * import is dynamic so that a `--dry-run` never loads it.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';
import { http1Fetch } from '../../src/lib/core/http1-fetch.js';
import { JUDGE_EFFORT } from './judge-criteria.js';

export async function createJudgeAnthropicClient(options: ClientOptions = {}): Promise<Anthropic> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  return new AnthropicClient({ ...options, fetch: http1Fetch });
}

export const MAX_TOKENS_STOP_REASON = 'max_tokens';

type JsonOutputSchema = Anthropic.Messages.JSONOutputFormat['schema'];

export function jsonSchemaFormat(schema: JsonOutputSchema): Anthropic.Messages.JSONOutputFormat {
  return { type: 'json_schema', schema };
}

/** Every judge request's thinking and output settings, with the JSON schema as `output_config.format` when given. */
export function judgeRequestSettings(
  schema: JsonOutputSchema | undefined,
): Pick<Anthropic.Messages.MessageCreateParamsNonStreaming, 'thinking' | 'output_config'> {
  return {
    thinking: { type: 'disabled' },
    output_config: { effort: JUDGE_EFFORT, ...(schema && { format: jsonSchemaFormat(schema) }) },
  };
}

/** A Messages API response's text blocks, joined; thinking and tool blocks are dropped. */
export function responseText(content: readonly Anthropic.Messages.ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
}
