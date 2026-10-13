import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createJudgeAnthropicClient, responseText } from '../judge-anthropic-client.js';
import { startRecordingServer, type RecordingServer } from './support/recording-server.js';

// Placeholder, not a credential: the local server only records it.
const API_KEY = 'test-key-value';
const MODEL = 'claude-haiku-4-5-20251001';
const REPLY_TEXT = 'ok';
const MAX_TOKENS = 16;
const HTTP_OK = 200;

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
    server = await startRecordingServer();
    server.respondWith(() => ({
      status: HTTP_OK,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MESSAGE_RESPONSE),
    }));
  });

  afterAll(() => server.close());

  it('sends a request through its own fetch with the caller options intact', async () => {
    const client = await createJudgeAnthropicClient({ apiKey: API_KEY, baseURL: server.url, maxRetries: 0 });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toEqual([{ type: 'text', text: REPLY_TEXT }]);
    expect(server.requests).toHaveLength(1);
    const [last] = server.requests;
    expect(last!.headers['x-api-key']).toBe(API_KEY);
    expect(last!.httpVersion).toBe('1.1');
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
