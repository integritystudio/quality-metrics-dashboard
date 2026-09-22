import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createBatchProvider,
  toOutputConfig,
  resolveJudgeApiKey,
  BatchRequestFailedError,
  BatchWallClockExceededError,
  LLM_JUDGE_KEY_ENV,
  ANTHROPIC_KEY_ENV,
  type BatchClient,
} from '../judge-batch-provider.js';
import { classifyJudgeFailure } from '../judge-evaluations.js';

type MessageBatch = Anthropic.Messages.MessageBatch;
type ResultLine = Anthropic.Messages.MessageBatchIndividualResponse;
type BatchRequests = Parameters<BatchClient['create']>[0]['requests'];

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.1;
const BATCH_ID = 'msgbatch_test';
/** Real timers, kept short: the provider's intervals are injectable. */
const FAST_MS = 5;
const BASE = { model: MODEL, maxTokens: MAX_TOKENS, temperature: TEMPERATURE, pollIntervalMs: FAST_MS, idleFlushMs: FAST_MS };

function makeBatch(status: MessageBatch['processing_status']): MessageBatch {
  return {
    id: BATCH_ID,
    type: 'message_batch',
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: '2026-09-20T06:00:00Z',
    expires_at: '2026-09-21T06:00:00Z',
    ended_at: null,
    archived_at: null,
    cancel_initiated_at: null,
    results_url: null,
  };
}

function succeeded(customId: string, text: string): ResultLine {
  const message = { content: [{ type: 'text', text }, { type: 'tool_use', id: 'x', name: 'y', input: {} }] } as unknown as Anthropic.Messages.Message;
  return { custom_id: customId, result: { type: 'succeeded', message } };
}

function errored(customId: string, type: 'billing_error' | 'invalid_request_error', message: string): ResultLine {
  const error = { type: 'error', request_id: null, error: { type, message } } as Anthropic.Messages.MessageBatchErroredResult['error'];
  return { custom_id: customId, result: { type: 'errored', error } };
}

function promptOf(request: BatchRequests[number]): string {
  const content = request.params.messages[0]?.content;
  return typeof content === 'string' ? content : '';
}

/** Captures a rejection as a value. Attached before the batch runs, so no rejection is ever unhandled. */
function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => { throw new Error('expected the promise to reject'); },
    (error: unknown) => error as Error,
  );
}

interface FakeClientOptions {
  /** What `retrieve` reports, in order; the last entry repeats. */
  statuses?: MessageBatch['processing_status'][];
  /** Results for the most recently submitted batch. */
  results: (requests: BatchRequests) => ResultLine[];
  create?: () => Promise<MessageBatch>;
}

function fakeClient(options: FakeClientOptions) {
  const submitted: BatchRequests[] = [];
  const statuses = options.statuses ?? ['ended'];
  let polls = 0;
  const client = {
    create: vi.fn((params: { requests: BatchRequests }) => {
      submitted.push(params.requests);
      return options.create ? options.create() : Promise.resolve(makeBatch('in_progress'));
    }),
    retrieve: vi.fn(() => Promise.resolve(makeBatch(statuses[Math.min(polls++, statuses.length - 1)]!))),
    // A stream, as the SDK's JSONL decoder is: the results file is read line by line.
    results: vi.fn(() => Promise.resolve(Readable.from(options.results(submitted.at(-1)!)))),
    cancel: vi.fn(() => Promise.resolve(makeBatch('canceling'))),
  } satisfies BatchClient;
  return { client, submitted };
}

const echo = (requests: BatchRequests): ResultLine[] => requests.map(r => succeeded(r.custom_id, `re:${promptOf(r)}`));

describe('createBatchProvider', () => {
  it('settles each generate() by custom_id when results arrive out of order', async () => {
    const { client, submitted } = fakeClient({ results: requests => echo([...requests].reverse()) });
    const provider = await createBatchProvider({ ...BASE, client });

    const alpha = provider.generate('alpha');
    const beta = provider.generate('beta', { temperature: 0.7 });
    const gamma = provider.generate('gamma');
    await provider.flush();

    expect(await alpha).toEqual({ text: 're:alpha' });
    expect(await beta).toEqual({ text: 're:beta' });
    expect(await gamma).toEqual({ text: 're:gamma' });
    expect(client.create).toHaveBeenCalledTimes(1);
    const requests = submitted[0]!;
    expect(new Set(requests.map(r => r.custom_id)).size).toBe(3);
    expect(requests[0]!.params).toEqual({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [{ role: 'user', content: 'alpha' }],
    });
    expect(requests[1]!.params.temperature).toBe(0.7);
  });

  it('polls until the batch has ended and only then reads results', async () => {
    const { client } = fakeClient({ statuses: ['in_progress', 'in_progress', 'ended'], results: echo });
    const provider = await createBatchProvider({ ...BASE, client });

    const one = provider.generate('one');
    await provider.flush();

    expect(await one).toEqual({ text: 're:one' });
    expect(client.retrieve).toHaveBeenCalledTimes(3);
    expect(client.results).toHaveBeenCalledTimes(1);
  });

  it('rejects errored, expired and canceled items with a typed error the judge can classify, and resolves the rest', async () => {
    const { client } = fakeClient({
      results: ([first, second, third, fourth]) => [
        errored(first!.custom_id, 'billing_error', 'Your credit balance is too low to access the Anthropic API.'),
        { custom_id: second!.custom_id, result: { type: 'expired' } },
        { custom_id: third!.custom_id, result: { type: 'canceled' } },
        succeeded(fourth!.custom_id, 'fine'),
      ],
    });
    const provider = await createBatchProvider({ ...BASE, client });

    const billed = rejection(provider.generate('a'));
    const expired = rejection(provider.generate('b'));
    const canceled = rejection(provider.generate('c'));
    const fine = provider.generate('d');
    await provider.flush();

    const billedError = await billed;
    expect(billedError).toBeInstanceOf(BatchRequestFailedError);
    expect(billedError).toMatchObject({ kind: 'errored' });
    expect(classifyJudgeFailure(billedError.message)).toBe('billing');
    expect(await expired).toMatchObject({ name: 'BatchRequestFailedError', kind: 'expired' });
    expect(await canceled).toMatchObject({ name: 'BatchRequestFailedError', kind: 'canceled' });
    expect(await fine).toEqual({ text: 'fine' });
    expect(provider.failure).toBeUndefined();
  });

  it('rejects a request the results file never mentions instead of leaving it waiting', async () => {
    const { client } = fakeClient({ results: () => [] });
    const provider = await createBatchProvider({ ...BASE, client });

    const forgotten = rejection(provider.generate('forgotten'));
    await provider.flush();

    expect(await forgotten).toMatchObject({ name: 'BatchRequestFailedError', kind: 'missing' });
  });

  it('ships the queue on its own after the idle window when nobody calls flush()', async () => {
    const { client } = fakeClient({ results: echo });
    const provider = await createBatchProvider({ ...BASE, client });

    expect(await provider.generate('solo')).toEqual({ text: 're:solo' });
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('flush() keeps shipping rounds until a call issued after a result is answered too', async () => {
    const { client } = fakeClient({ results: echo });
    const provider = await createBatchProvider({ ...BASE, client });

    const chained = provider.generate('first').then(first => provider.generate(`${first.text}/second`));
    await provider.flush();

    expect(await chained).toEqual({ text: 're:re:first/second' });
    expect(client.create).toHaveBeenCalledTimes(2);
  });

  it('cancels the batch, rejects every open promise and fails flush() when the wall clock runs out', async () => {
    const { client } = fakeClient({ statuses: ['in_progress'], results: echo });
    const provider = await createBatchProvider({ ...BASE, client, wallClockMs: 0 });

    const open = rejection(provider.generate('never'));
    await expect(provider.flush()).rejects.toBeInstanceOf(BatchWallClockExceededError);

    expect(client.cancel).toHaveBeenCalledWith(BATCH_ID);
    expect(client.results).not.toHaveBeenCalled();
    expect(await open).toBeInstanceOf(BatchWallClockExceededError);
    expect(provider.failure).toBeInstanceOf(BatchWallClockExceededError);
    await expect(provider.generate('after')).rejects.toBe(provider.failure);
    await expect(provider.flush()).rejects.toBe(provider.failure);
  });

  it('fails only that batch, with the API error, when the batch cannot be created', async () => {
    const { client } = fakeClient({ results: echo, create: () => Promise.reject(new Error('Connection error.')) });
    const provider = await createBatchProvider({ ...BASE, client });

    const lost = rejection(provider.generate('lost'));
    await provider.flush();

    expect(classifyJudgeFailure((await lost).message)).toBe('network');
    expect(provider.failure).toBeUndefined();
  });

  it('maps a jsonSchema option onto output_config', async () => {
    const schema = { type: 'object', properties: { score: { type: 'number' } } };
    expect(toOutputConfig({ jsonSchema: schema })).toEqual({ output_config: { format: { type: 'json_schema', schema } } });
    expect(toOutputConfig({ temperature: 0 })).toEqual({});

    const { client, submitted } = fakeClient({ results: echo });
    const provider = await createBatchProvider({ ...BASE, client });
    const structured = provider.generate('structured', { jsonSchema: schema });
    await provider.flush();
    await structured;
    expect(submitted[0]![0]!.params.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });
});

describe('resolveJudgeApiKey', () => {
  it('prefers the judge key, falls back to the shared key, and yields undefined with neither', () => {
    expect(resolveJudgeApiKey({ [LLM_JUDGE_KEY_ENV]: 'judge-key', [ANTHROPIC_KEY_ENV]: 'shared-key' })).toBe('judge-key');
    expect(resolveJudgeApiKey({ [ANTHROPIC_KEY_ENV]: 'shared-key' })).toBe('shared-key');
    expect(resolveJudgeApiKey({ [LLM_JUDGE_KEY_ENV]: '' })).toBeUndefined();
  });
});
