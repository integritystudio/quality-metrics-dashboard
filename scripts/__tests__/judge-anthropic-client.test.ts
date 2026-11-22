import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ALPN_HTTP1_1 } from '../../../src/test-helpers/alpn-server.js';
import { http1Fetch } from '../../../src/lib/core/http1-fetch.js';
import { createJudgeAnthropicClient, responseText } from '../judge-anthropic-client.js';
import { setScriptFetch } from '../script-fetch.js';
import { startRecordingServer, type RecordingServer } from './support/recording-server.js';
import { assertDefined } from '../../src/__tests__/support/defined.js';
import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../../src/lib/http-constants.js';

// Placeholder, not a credential: the local server only records it.
const API_KEY = 'test-key-value';
const MODEL = 'claude-haiku-4-5-20251001';
const REPLY_TEXT = 'ok';
const MAX_TOKENS = 16;

const MESSAGE_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: REPLY_TEXT }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

describe('createJudgeAnthropicClient', () => {
  let server: RecordingServer;

  beforeAll(async () => {
    // What `runIfMain` installs for every CLI.
    setScriptFetch(http1Fetch);
    server = await startRecordingServer({ tls: true });
    server.respondWith(() => ({
      status: HttpStatus.Ok,
      headers: { [CONTENT_TYPE_HEADER]: ContentType.Json },
      body: JSON.stringify(MESSAGE_RESPONSE),
    }));
  });

  afterAll(async () => {
    setScriptFetch(undefined);
    await server.close();
  });

  it('sends a request through the script fetch with the caller options intact', async () => {
    const client = await createJudgeAnthropicClient({ apiKey: API_KEY, baseURL: server.url, maxRetries: 0 });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toEqual([{ type: 'text', text: REPLY_TEXT }]);
    expect(server.requests).toHaveLength(1);
    const [last] = server.requests;
    assertDefined(last);
    expect(last.headers['x-api-key']).toBe(API_KEY);
    expect(last.alpnProtocol).toBe(ALPN_HTTP1_1);
  });

  it('uses the fetch the caller passes over the script fetch, as a Worker does', async () => {
    const requested: string[] = [];
    const client = await createJudgeAnthropicClient({
      apiKey: API_KEY,
      baseURL: 'https://anthropic.test',
      maxRetries: 0,
      fetch: (input) => {
        requested.push(new Request(input).url);
        return Promise.resolve(Response.json(MESSAGE_RESPONSE));
      },
    });

    const response = await client.messages.create({ model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: 'hi' }] });

    expect(response.content).toEqual([{ type: 'text', text: REPLY_TEXT }]);
    expect(requested).toEqual(['https://anthropic.test/v1/messages']);
  });
});

describe('responseText', () => {
  it('joins the text blocks and drops the rest', () => {
    const content = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
      { type: 'text', text: 'Score: ', citations: null },
      { type: 'text', text: '4', citations: null },
    ] as const;
    expect(responseText(content)).toBe('Score: 4');
  });
});
