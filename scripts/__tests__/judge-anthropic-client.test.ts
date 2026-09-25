import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingHttpHeaders, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createJudgeAnthropicClient } from '../judge-anthropic-client.js';

// Placeholder, not a credential: the local server only echoes it back.
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
  let server: Server;
  let baseURL: string;
  const received: { headers: IncomingHttpHeaders; httpVersion: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      received.push({ headers: req.headers, httpVersion: req.httpVersion });
      req.resume();
      req.on('end', () => {
        res.writeHead(HTTP_OK, { 'content-type': 'application/json' });
        res.end(JSON.stringify(MESSAGE_RESPONSE));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('sends a request through its own fetch with the caller options intact', async () => {
    const client = await createJudgeAnthropicClient({ apiKey: API_KEY, baseURL, maxRetries: 0 });

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.content).toEqual([{ type: 'text', text: REPLY_TEXT }]);
    const last = received.at(-1)!;
    expect(last.headers['x-api-key']).toBe(API_KEY);
    expect(last.httpVersion).toBe('1.1');
  });
});
