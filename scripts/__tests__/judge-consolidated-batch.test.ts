import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import type Anthropic from '@anthropic-ai/sdk';
import { createBatchProvider, type BatchClient } from '../judge-batch-provider.js';
import {
  adaptBatchProvider,
  evaluateTurnsConsolidatedBatched,
  CONSOLIDATED_MAX_TOKENS,
} from '../judge-consolidated.js';
import {
  estimateJudgeRun,
  resetFailureTracking,
  RELEVANCE_EVAL_NAME,
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  TIMESTAMP_TURN_KEY_LEN,
  BATCH_PRICE_RATIO,
  type Turn,
} from '../judge-evaluations.js';
import { HALLUCINATION_EVAL_NAME } from '../../../src/lib/validation/dashboard-schemas.js';

type MessageBatch = Anthropic.Messages.MessageBatch;
type ResultLine = Anthropic.Messages.MessageBatchIndividualResponse;
type BatchRequests = Parameters<BatchClient['create']>[0]['requests'];
type BatchRequest = BatchRequests[number];

const MODEL = 'claude-haiku-4-5-20251001';
const PROVIDER_MAX_TOKENS = 1024;
const TEMPERATURE = 0.1;
const FAST_MS = 5;
const BASE = { model: MODEL, maxTokens: PROVIDER_MAX_TOKENS, temperature: TEMPERATURE, pollIntervalMs: FAST_MS, idleFlushMs: FAST_MS };
const VERDICT_SCORE = 4;
const STEPS_TEXT = '1. Read the input.\n2. Read the output.\n3. Compare them.';
const STEPS_PROMPT_MARKER = 'Generate detailed evaluation steps';

function makeBatch(status: MessageBatch['processing_status']): MessageBatch {
  return {
    id: 'msgbatch_test',
    type: 'message_batch',
    processing_status: status,
    request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: '2026-09-22T06:00:00Z',
    expires_at: '2026-09-23T06:00:00Z',
    ended_at: null,
    archived_at: null,
    cancel_initiated_at: null,
    results_url: null,
  };
}

function promptOf(request: BatchRequest): string {
  const content = request.params.messages[0]?.content;
  return typeof content === 'string' ? content : '';
}

/** The criterion names a verdict request's schema requires. */
function schemaKeys(request: BatchRequest): string[] {
  const format = request.params.output_config?.format as { schema?: { required?: string[] } } | undefined;
  return format?.schema?.required ?? [];
}

/** Steps requests get a numbered list; verdict requests get one JSON verdict per required criterion. */
function answer(request: BatchRequest): ResultLine {
  const text = promptOf(request).includes(STEPS_PROMPT_MARKER)
    ? STEPS_TEXT
    : JSON.stringify(Object.fromEntries(schemaKeys(request).map(name => [name, { reasoning: 'ok', score: VERDICT_SCORE }])));
  const message = { content: [{ type: 'text', text }] } as unknown as Anthropic.Messages.Message;
  return { custom_id: request.custom_id, result: { type: 'succeeded', message } };
}

function fakeClient() {
  const submitted: BatchRequests[] = [];
  const client = {
    create: vi.fn((params: { requests: BatchRequests }) => {
      submitted.push(params.requests);
      return Promise.resolve(makeBatch('in_progress'));
    }),
    retrieve: vi.fn(() => Promise.resolve(makeBatch('ended'))),
    results: vi.fn(() => Promise.resolve(Readable.from(submitted.at(-1)!.map(answer)))),
    cancel: vi.fn(() => Promise.resolve(makeBatch('canceling'))),
  } satisfies BatchClient;
  return { client, submitted };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: 'abc12345-session',
    traceId: 'trace-001',
    timestamp: '2026-09-22T01:11:15.525Z',
    userText: 'What does this function do?',
    assistantText: 'It parses the config file.',
    toolResults: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetFailureTracking();
});

describe('adaptBatchProvider', () => {
  it('gives a schema call the consolidated budget and the schema as output_config', async () => {
    const { client, submitted } = fakeClient();
    const provider = adaptBatchProvider(await createBatchProvider({ ...BASE, client }));
    const schema = { type: 'object', properties: {}, required: [] };
    await provider.generate('verdict please', { schema });
    const [request] = submitted.flat();
    expect(request!.params.max_tokens).toBe(CONSOLIDATED_MAX_TOKENS);
    expect(request!.params.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });

  it('leaves a schema-less call on the provider budget with no output_config', async () => {
    const { client, submitted } = fakeClient();
    const provider = adaptBatchProvider(await createBatchProvider({ ...BASE, client }));
    await provider.generate(STEPS_PROMPT_MARKER);
    const [request] = submitted.flat();
    expect(request!.params.max_tokens).toBe(PROVIDER_MAX_TOKENS);
    expect(request!.params.output_config).toBeUndefined();
  });
});

describe('evaluateTurnsConsolidatedBatched', () => {
  it('ships the steps in one round and every turn\'s verdict in the next', async () => {
    const { client, submitted } = fakeClient();
    const batch = await createBatchProvider({ ...BASE, client });
    const turns = [makeTurn(), makeTurn({ sessionId: 'def67890-session' })];

    const records = await evaluateTurnsConsolidatedBatched(batch, turns, new Set());

    expect(submitted).toHaveLength(2);
    // Two criteria without tool results; steps are shared across turns through the cache.
    expect(submitted[0]!.map(promptOf).every(p => p.includes(STEPS_PROMPT_MARKER))).toBe(true);
    expect(submitted[0]).toHaveLength(2);
    // One verdict call per turn, not one per criterion.
    expect(submitted[1]).toHaveLength(turns.length);
    expect(records.map(perTurn => perTurn.map(r => r.evaluationName))).toEqual([
      [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME],
      [RELEVANCE_EVAL_NAME, COHERENCE_EVAL_NAME],
    ]);
  });

  it('derives hallucination from the faithfulness verdict on a turn with tool results', async () => {
    const { client } = fakeClient();
    const batch = await createBatchProvider({ ...BASE, client });

    const [records] = await evaluateTurnsConsolidatedBatched(batch, [makeTurn({ toolResults: ['config.yaml: port 8080'] })], new Set());

    const byName = Object.fromEntries(records!.map(r => [r.evaluationName, r.scoreValue]));
    expect(byName[FAITHFULNESS_EVAL_NAME]).toBe(0.75);
    expect(byName[HALLUCINATION_EVAL_NAME]).toBe(0.25);
  });

  it('skips criteria that already have a record', async () => {
    const { client, submitted } = fakeClient();
    const batch = await createBatchProvider({ ...BASE, client });
    const turn = makeTurn();
    const existing = new Set([`${turn.sessionId}:${RELEVANCE_EVAL_NAME}:${turn.timestamp.slice(0, TIMESTAMP_TURN_KEY_LEN)}`]);

    const [records] = await evaluateTurnsConsolidatedBatched(batch, [turn], existing);

    expect(records!.map(r => r.evaluationName)).toEqual([COHERENCE_EVAL_NAME]);
    expect(schemaKeys(submitted[1]![0]!)).toEqual([COHERENCE_EVAL_NAME]);
  });
});

describe('estimateJudgeRun (consolidated)', () => {
  it('counts one call per turn and prices below the per-criterion estimate', () => {
    const turns = [makeTurn(), makeTurn({ toolResults: ['x'.repeat(4000)] })];
    const consolidated = estimateJudgeRun(turns, false, true);
    const perCriterion = estimateJudgeRun(turns, false, false);
    expect(consolidated.evals).toBe(turns.length);
    expect(consolidated.costUsd).toBeLessThan(perCriterion.costUsd);
  });

  it('prices at the batch rate under --batch', () => {
    const turns = [makeTurn({ toolResults: ['x'.repeat(4000)] })];
    expect(estimateJudgeRun(turns, true, true).costUsd).toBeCloseTo(estimateJudgeRun(turns, false, true).costUsd * BATCH_PRICE_RATIO, 10);
  });
});
