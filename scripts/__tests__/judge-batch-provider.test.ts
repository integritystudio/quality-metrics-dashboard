import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createBatchProvider,
  toOutputConfig,
  BatchRequestFailedError,
  BatchWallClockExceededError,
  BATCH_CANCEL_GRACE_MS,
  BATCH_POLL_INTERVAL_MS,
  BATCH_WALL_CLOCK_MS,
  type BatchClient,
} from '../judge-batch-provider.js';
import {
  classifyJudgeFailure,
  evalFailures,
  failureClasses,
  resetFailureTracking,
  summarizeJudgeRun,
} from '../judge-failures.js';
import { createUsageTotals } from '../judge-usage.js';
import { evaluateTurnsBatched, BATCH_MODE_JUDGE_TIMEOUT_MS, BATCH_MODE_MAX_RETRIES } from '../judge-evaluations.js';
import { COHERENCE_EVAL_NAME, RELEVANCE_EVAL_NAME } from '../judge-criteria.js';
import { type Turn } from '../judge-turns.js';
import { evaluateTurnsConsolidatedBatched } from '../judge-consolidated.js';
import { LLMJudge } from '../../../src/lib/judge/llm-judge-config.js';
import { DEFAULT_API_KEY_ENV } from '../judge-credentials.js';
import { JUDGE_EXIT_BATCH_WALL_CLOCK, JUDGE_SOFT_FAILURE_EXITS } from '../pipeline-stages.js';

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
/**
 * A 2xx whose body is no batch: the SDK resolves it, and the provider has
 * nothing to read a status from. The one thing the fake can hand back that
 * escapes every per-call catch, which is what breaks a run rather than a batch.
 */
const NO_BATCH = null as unknown as MessageBatch;

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

/** What one poll reports: the batch's status, or the error the poll fails with. */
type PollOutcome = MessageBatch['processing_status'] | Error;

interface FakeClientOptions {
  /** What `retrieve` reports, in order; the last entry repeats. */
  statuses?: PollOutcome[];
  /** What `retrieve` reports once `cancel` has been called, in order; the last entry repeats. A batch that never ends by default. */
  afterCancel?: PollOutcome[];
  /** Results for the most recently submitted batch; a throw here is a results read that fails. */
  results: (requests: BatchRequests) => ResultLine[];
  create?: () => Promise<MessageBatch>;
  cancel?: () => Promise<MessageBatch>;
}

function fakeClient(options: FakeClientOptions) {
  const submitted: BatchRequests[] = [];
  let statuses = options.statuses ?? ['ended'];
  let polls = 0;
  const client = {
    create: vi.fn((params: { requests: BatchRequests }) => {
      submitted.push(params.requests);
      return options.create ? options.create() : Promise.resolve(makeBatch('in_progress'));
    }),
    retrieve: vi.fn(() => {
      const outcome = statuses[Math.min(polls++, statuses.length - 1)]!;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(makeBatch(outcome));
    }),
    // A stream, as the SDK's JSONL decoder is: the results file is read line by line.
    results: vi.fn(() => Promise.resolve().then(() => Readable.from(options.results(submitted.at(-1)!)))),
    cancel: vi.fn(() => {
      statuses = options.afterCancel ?? ['canceling'];
      polls = 0;
      return options.cancel ? options.cancel() : Promise.resolve(makeBatch('canceling'));
    }),
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
    expect(client.cancel).not.toHaveBeenCalled();
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

  it('fails only that batch, with the API error, when the batch cannot be created', async () => {
    const { client } = fakeClient({ results: echo, create: () => Promise.reject(new Error('Connection error.')) });
    const provider = await createBatchProvider({ ...BASE, client });

    const lost = rejection(provider.generate('lost'));
    await provider.flush();

    expect(classifyJudgeFailure((await lost).message)).toBe('network');
    expect(provider.failure).toBeUndefined();
  });

  it('records an error that escapes a batch as the failure, rejects every open call with it, and refuses every later call', async () => {
    const { client } = fakeClient({ results: echo, create: () => Promise.resolve(NO_BATCH) });
    const provider = await createBatchProvider({ ...BASE, client });

    const lost = rejection(provider.generate('lost'));
    const alsoLost = rejection(provider.generate('also lost'));
    const failure = await rejection(provider.flush());

    expect(await lost).toBe(failure);
    expect(await alsoLost).toBe(failure);
    expect(provider.failure).toBe(failure);
    await expect(provider.generate('after')).rejects.toBe(failure);
    await expect(provider.flush()).rejects.toBe(failure);
    expect(client.create).toHaveBeenCalledTimes(1);
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

  it('rejects a succeeded request when the onUsage callback throws, instead of leaving it pending (JUDGE-BATCH-SETTLE-THROW-LEAVES-PENDING)', async () => {
    const callbackError = new Error('usage callback failed');
    const { client } = fakeClient({ results: echo });
    const provider = await createBatchProvider({ ...BASE, client, onUsage: () => { throw callbackError; } });

    const result = rejection(provider.generate('q'));
    await provider.flush();

    expect(await result).toBe(callbackError);
  });
});

// ---------------------------------------------------------------------------
// The wall clock (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN)
// ---------------------------------------------------------------------------

/** The provider's own intervals: these tests run on vitest's clock, so none of them waits. */
const PRODUCTION = { model: MODEL, maxTokens: MAX_TOKENS, temperature: TEMPERATURE };
const POLLS_TO_WALL_CLOCK = 4;
const POLLS_OF_GRACE = 3;
/** A wall clock and a grace a few polls long, for the cases that do not turn on the production numbers. */
const SHORT = {
  ...PRODUCTION,
  wallClockMs: POLLS_TO_WALL_CLOCK * BATCH_POLL_INTERVAL_MS,
  cancelGraceMs: POLLS_OF_GRACE * BATCH_POLL_INTERVAL_MS,
};

/** A poll lost to the network. */
const POLL_LOST = new Error('Connection error.');

/** Runs the fake clock, one poll interval at a time, until `work` settles. */
async function runClock<T>(work: Promise<T>): Promise<T> {
  let settled = false;
  const done = (): void => { settled = true; };
  work.then(done, done);
  // `settled` is set by the callback above, which TypeScript's flow analysis
  // cannot see across the async boundary — the condition is not constant.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (!settled) await vi.advanceTimersByTimeAsync(BATCH_POLL_INTERVAL_MS);
  return work;
}

describe('createBatchProvider at the wall clock', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
  });

  it('settles what the cancelled batch had already answered, once each, and abandons the rest', async () => {
    const onUsage = vi.fn();
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: ['canceling', 'ended'],
      // The fourth request gets no line at all.
      results: ([first, second, third]) => [
        succeeded(first!.custom_id, 'kept'),
        errored(second!.custom_id, 'invalid_request_error', 'max_tokens: too large'),
        { custom_id: third!.custom_id, result: { type: 'canceled' } },
      ],
    });
    const provider = await createBatchProvider({ ...SHORT, client, onUsage });

    const kept = provider.generate('a');
    const refused = rejection(provider.generate('b'));
    const cancelled = rejection(provider.generate('c'));
    const unmentioned = rejection(provider.generate('d'));
    const flushResult = await runClock(provider.flush());

    expect(await kept).toEqual({ text: 'kept' });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(await refused).toMatchObject({ name: 'BatchRequestFailedError', kind: 'errored' });
    const overrun = await cancelled;
    expect(overrun).toBeInstanceOf(BatchWallClockExceededError);
    expect(await unmentioned).toBe(overrun);
    expect(overrun).toMatchObject({ batchId: BATCH_ID, abandoned: 2 });
    expect(classifyJudgeFailure(overrun.message)).toBe('wall-clock');
    expect(flushResult).toMatchObject({ settled: 2, abandoned: 2 });
    expect(flushResult.overrun).toBe(overrun);
    expect(client.cancel).toHaveBeenCalledTimes(1);
    // Read once, and only after the poll that saw the batch end.
    expect(client.results).toHaveBeenCalledTimes(1);
    expect(client.results.mock.invocationCallOrder[0]).toBeGreaterThan(client.retrieve.mock.invocationCallOrder.at(-1)!);
    expect(provider.failure).toBeUndefined();
    await expect(provider.generate('after')).rejects.toBe(overrun);
  });

  it('cancels at three hours, gives the batch ten minutes to end, then abandons every request unread', async () => {
    let cancelledAt = 0;
    const { client } = fakeClient({
      statuses: ['in_progress'],
      results: echo,
      cancel: () => {
        cancelledAt = Date.now();
        return Promise.resolve(makeBatch('canceling'));
      },
    });
    const provider = await createBatchProvider({ ...PRODUCTION, client });
    const startedAt = Date.now();

    const open = rejection(provider.generate('never'));
    await runClock(provider.flush());

    expect(client.cancel).toHaveBeenCalledWith(BATCH_ID);
    expect(cancelledAt - startedAt).toBeGreaterThanOrEqual(BATCH_WALL_CLOCK_MS);
    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(BATCH_CANCEL_GRACE_MS);
    expect(client.results).not.toHaveBeenCalled();
    const overrun = await open;
    expect(overrun).toBeInstanceOf(BatchWallClockExceededError);
    expect(overrun).toMatchObject({ abandoned: 1 });
    expect(provider.failure).toBeUndefined();
    await expect(provider.generate('after')).rejects.toBe(overrun);
    await expect(runClock(provider.flush())).resolves.toMatchObject({ settled: 0, abandoned: 0 });
  });

  it('abandons every request without waiting when the cancel itself fails', async () => {
    let pollsAtCancel = 0;
    const fake = fakeClient({
      statuses: ['in_progress'],
      results: echo,
      cancel: () => {
        pollsAtCancel = fake.client.retrieve.mock.calls.length;
        return Promise.reject(new Error('Connection error.'));
      },
    });
    const provider = await createBatchProvider({ ...SHORT, client: fake.client });

    const open = rejection(provider.generate('never'));
    await runClock(provider.flush());

    expect(pollsAtCancel).toBe(POLLS_TO_WALL_CLOCK);
    expect(fake.client.retrieve).toHaveBeenCalledTimes(pollsAtCancel);
    expect(fake.client.results).not.toHaveBeenCalled();
    expect(await open).toMatchObject({ name: 'BatchWallClockExceededError', abandoned: 1 });
  });

  it('refuses a call that follows from a result settled at the wall clock, rather than queueing it', async () => {
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: ['ended'],
      results: ([first]) => [succeeded(first!.custom_id, 'first')],
    });
    const provider = await createBatchProvider({ ...SHORT, client });

    const followUp = rejection(provider.generate('first').then(first => provider.generate(`${first.text}/second`)));
    await runClock(provider.flush());

    const overrun = await followUp;
    expect(overrun).toBeInstanceOf(BatchWallClockExceededError);
    // The one request the batch held was answered, so nothing was abandoned.
    expect(overrun).toMatchObject({ abandoned: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('settled 1 results it had already produced, abandoned 0 requests'));
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('leaves an expired line open, to be abandoned with the rest, as it does a canceled one', async () => {
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: ['ended'],
      results: ([first, second]) => [
        succeeded(first!.custom_id, 'kept'),
        { custom_id: second!.custom_id, result: { type: 'expired' } },
      ],
    });
    const provider = await createBatchProvider({ ...SHORT, client });

    const kept = provider.generate('a');
    const expired = rejection(provider.generate('b'));
    await runClock(provider.flush());

    expect(await kept).toEqual({ text: 'kept' });
    const overrun = await expired;
    expect(overrun).toBeInstanceOf(BatchWallClockExceededError);
    expect(overrun).toMatchObject({ abandoned: 1 });
  });

  it('abandons every request with the overrun, not a failure, when the ended batch\'s results cannot be read', async () => {
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: ['ended'],
      results: () => { throw new Error('Connection error.'); },
    });
    const provider = await createBatchProvider({ ...SHORT, client });

    const first = rejection(provider.generate('a'));
    const second = rejection(provider.generate('b'));
    await runClock(provider.flush());

    const overrun = await first;
    expect(overrun).toBeInstanceOf(BatchWallClockExceededError);
    expect(await second).toBe(overrun);
    expect(overrun).toMatchObject({ abandoned: 2 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not be read'));
    expect(provider.failure).toBeUndefined();
  });

  it('keeps polling past a poll lost during the grace, and reads the results once the next one sees the batch end', async () => {
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: [POLL_LOST, 'ended'],
      results: ([first]) => [succeeded(first!.custom_id, 'kept')],
    });
    const provider = await createBatchProvider({ ...SHORT, client });

    const kept = provider.generate('a');
    await runClock(provider.flush());

    expect(await kept).toEqual({ text: 'kept' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(POLL_LOST.message));
    expect(client.results).toHaveBeenCalledTimes(1);
    expect(provider.failure).toBeUndefined();
  });

  it('abandons every request unread once the grace runs out when every poll in it is lost', async () => {
    let cancelledAt = 0;
    const { client } = fakeClient({
      statuses: ['in_progress'],
      afterCancel: [POLL_LOST],
      results: echo,
      cancel: () => {
        cancelledAt = Date.now();
        return Promise.resolve(makeBatch('canceling'));
      },
    });
    const provider = await createBatchProvider({ ...SHORT, client });

    const open = rejection(provider.generate('never'));
    await runClock(provider.flush());

    expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(SHORT.cancelGraceMs);
    expect(client.results).not.toHaveBeenCalled();
    expect(await open).toMatchObject({ name: 'BatchWallClockExceededError', abandoned: 1 });
    expect(provider.failure).toBeUndefined();
  });

  it('reads a batch that ends on the last poll inside the wall clock as before, without cancelling', async () => {
    const stillProcessing = Array<MessageBatch['processing_status']>(POLLS_TO_WALL_CLOCK - 1).fill('in_progress');
    const { client } = fakeClient({ statuses: [...stillProcessing, 'ended'], results: echo });
    const provider = await createBatchProvider({ ...SHORT, client });

    const one = provider.generate('one');
    await runClock(provider.flush());

    expect(await one).toEqual({ text: 're:one' });
    expect(client.retrieve).toHaveBeenCalledTimes(POLLS_TO_WALL_CLOCK);
    expect(client.cancel).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(provider.failure).toBeUndefined();
  });
});

describe('BATCH_MODE_JUDGE_TIMEOUT_MS', () => {
  // Otherwise a result the provider settles inside the grace is already a
  // per-call timeout at the judge: the discard the wall-clock change ended.
  it('outlasts the wall clock, the grace a cancelled batch gets, and the poll that sees it end', () => {
    expect(BATCH_MODE_JUDGE_TIMEOUT_MS).toBeGreaterThanOrEqual(BATCH_WALL_CLOCK_MS + BATCH_CANCEL_GRACE_MS + BATCH_POLL_INTERVAL_MS);
  });
});

const STEPS_TEXT = '1. Read the input.\n2. Read the output.\n3. Compare them.';
const VERDICT_SCORE = 4;
const SCORED_MARKER = 'scored-before-the-wall-clock';

/** The criterion names a consolidated verdict request's schema requires; none on an evaluation-steps request. */
function requiredCriteria(request: BatchRequests[number]): string[] {
  const format = request.params.output_config?.format as { schema?: { required?: string[] } } | undefined;
  return format?.schema?.required ?? [];
}

function makeTurn(overrides: Partial<Turn>): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-09-29T12:00:00.000Z',
    userText: 'What does this function do?',
    assistantText: 'It parses the config file.',
    toolResults: [],
    ...overrides,
  };
}

describe('a consolidated --batch run cut short by the wall clock', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetFailureTracking();
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    resetFailureTracking();
  });

  it('keeps the turn the cancelled batch had scored, counts the other as wall-clock, and exits soft so upload and sync still run', async () => {
    // The evaluation-steps batch ends on its first poll; the verdict batch is
    // still processing at the wall clock, with one of its two turns answered.
    const { client, submitted } = fakeClient({
      statuses: ['ended', 'in_progress'],
      afterCancel: ['ended'],
      results: requests => requests.map((request): ResultLine => {
        const criteria = requiredCriteria(request);
        if (criteria.length === 0) return succeeded(request.custom_id, STEPS_TEXT);
        if (!promptOf(request).includes(SCORED_MARKER)) return { custom_id: request.custom_id, result: { type: 'canceled' } };
        return succeeded(request.custom_id, JSON.stringify(Object.fromEntries(criteria.map(name => [name, { reasoning: 'ok', score: VERDICT_SCORE }]))));
      }),
    });
    const batch = await createBatchProvider({ ...SHORT, client });
    const turns = [
      makeTurn({ sessionId: 'scored00-session', userText: `Is this ${SCORED_MARKER}?` }),
      makeTurn({ sessionId: 'abandon0-session' }),
    ];

    const perTurn = await runClock(evaluateTurnsConsolidatedBatched(batch, turns, new Set()));

    expect(submitted).toHaveLength(2);
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(perTurn.map(records => records.map(r => r.evaluationName))).toEqual([[RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME], []]);
    expect(failureClasses).toMatchObject({ 'wall-clock': 2, other: 0 });

    const summary = summarizeJudgeRun(
      perTurn.flat().length,
      evalFailures,
      failureClasses,
      { usage: createUsageTotals(), estimatedUsd: 0, keySource: DEFAULT_API_KEY_ENV },
    );
    expect(summary.exitCode).toBe(JUDGE_EXIT_BATCH_WALL_CLOCK);
    expect(JUDGE_SOFT_FAILURE_EXITS.has(summary.exitCode)).toBe(true);
    expect(summary.line).toContain('attempted=4 succeeded=2 failed=2 classes: wall-clock=2');
  });
});

/** A G-Eval verdict as the score schema asks for it. */
const VERDICT_TEXT = JSON.stringify({ reasoning: 'ok', score: VERDICT_SCORE });

describe('a per-criterion --batch run cut short by the wall clock', () => {
  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetFailureTracking();
  });

  afterEach(() => {
    vi.useRealTimers();
    warn.mockRestore();
    resetFailureTracking();
  });

  it('keeps each turn\'s scored criteria, counts the rest as wall-clock, and resolves rather than throwing', async () => {
    // Each criterion is two calls: evaluation steps, then a schema-bound score.
    // The steps batch ends on its first poll; the score batch is still
    // processing at the wall clock, with one turn's scores answered. The marker
    // sits in the assistant's text: coherence judges the output alone, so that
    // is the one field every criterion's score prompt carries.
    const { client, submitted } = fakeClient({
      statuses: ['ended', 'in_progress'],
      afterCancel: ['ended'],
      results: requests => requests.map((request): ResultLine => {
        if (!request.params.output_config) return succeeded(request.custom_id, STEPS_TEXT);
        if (!promptOf(request).includes(SCORED_MARKER)) return { custom_id: request.custom_id, result: { type: 'canceled' } };
        return succeeded(request.custom_id, VERDICT_TEXT);
      }),
    });
    const batch = await createBatchProvider({ ...SHORT, client });
    const judge = new LLMJudge(batch, { timeoutMs: BATCH_MODE_JUDGE_TIMEOUT_MS, maxRetries: BATCH_MODE_MAX_RETRIES });
    const turns = [
      makeTurn({ sessionId: 'scored00-session', assistantText: `It is ${SCORED_MARKER}.` }),
      makeTurn({ sessionId: 'abandon0-session' }),
    ];

    const perTurn = await runClock(evaluateTurnsBatched(batch, judge, turns, new Set()));

    expect(submitted).toHaveLength(2);
    expect(client.cancel).toHaveBeenCalledTimes(1);
    expect(perTurn.map(records => records.map(r => r.evaluationName).sort())).toEqual([[COHERENCE_EVAL_NAME, RELEVANCE_EVAL_NAME], []]);
    expect(failureClasses).toMatchObject({ 'wall-clock': 2, other: 0 });
    expect(evalFailures).toEqual({ [RELEVANCE_EVAL_NAME]: 1, [COHERENCE_EVAL_NAME]: 1 });
    expect(batch.failure).toBeUndefined();
  });
});

