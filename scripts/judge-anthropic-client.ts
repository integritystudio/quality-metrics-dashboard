/**
 * The one place judge scripts construct an Anthropic client.
 *
 * Every client gets an HTTP/1.1 `fetch`. Node's built-in fetch (Node 26,
 * bundled undici 8) multiplexes all requests over one HTTP/2 session per
 * origin, and once that session is destroyed it keeps handing out the dead
 * session: every later request fails at once with `fetch failed <-
 * ERR_HTTP2_INVALID_SESSION`, which the SDK reports only as "Connection
 * error.", and no socket is opened. A synchronous judge run hit it three to
 * four minutes in, twice, and scored nothing after (2026-09-24,
 * judge-hallucination-eval.ts). Over HTTP/1.1 a dead connection is dropped
 * from the pool and the next request opens a new one.
 *
 * Both imports are dynamic so that a `--seed` run never loads the SDK.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ClientOptions } from '@anthropic-ai/sdk';

type SdkFetch = NonNullable<ClientOptions['fetch']>;

let http1Fetch: SdkFetch | undefined;

async function getHttp1Fetch(): Promise<SdkFetch> {
  if (http1Fetch) return http1Fetch;
  const { fetch, Agent } = await import('undici');
  const dispatcher = new Agent({ allowH2: false });
  // The cast covers one method: the parent's `@types/node` types the global
  // `Response` from `undici-types` 8, which has `textStream()`, and this app's
  // undici 7 `Response` does not. No caller uses it. Drop it with undici 8.
  const wrapped: SdkFetch = (input, init) =>
    fetch(input, { ...init, dispatcher }) as Promise<Response>;
  http1Fetch = wrapped;
  return wrapped;
}

export async function createJudgeAnthropicClient(options: ClientOptions = {}): Promise<Anthropic> {
  const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
  return new AnthropicClient({ ...options, fetch: await getHttp1Fetch() });
}

export const MAX_TOKENS_STOP_REASON = 'max_tokens';

type JsonOutputSchema = Anthropic.Messages.JSONOutputFormat['schema'];

export function jsonSchemaFormat(schema: JsonOutputSchema): Anthropic.Messages.JSONOutputFormat {
  return { type: 'json_schema', schema };
}

/** `{}` without a schema, so the request is unchanged. */
export function jsonSchemaOutputConfig(
  schema: JsonOutputSchema | undefined,
): Pick<Anthropic.Messages.MessageCreateParamsNonStreaming, 'output_config'> {
  return schema ? { output_config: { format: jsonSchemaFormat(schema) } } : {};
}

/** A Messages API response's text blocks, joined; thinking and tool blocks are dropped. */
export function responseText(content: readonly Anthropic.Messages.ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('');
}
