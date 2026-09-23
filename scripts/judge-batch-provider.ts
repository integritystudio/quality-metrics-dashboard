/**
 * Message Batches provider for the scheduled judge (`--batch`).
 *
 * Nobody waits on the twice-daily launchd run, so its calls go through the
 * Message Batches API: every token at half price, results usually within
 * minutes, a hard 24-hour expiry. `generate()` queues a request and hands back
 * a promise; `flush()` ships the queue as one batch, polls it to `ended`, and
 * settles every promise by `custom_id` — never by position, because the
 * results file is not in request order.
 *
 * The judge library chains calls (G-Eval scores after it generates steps; QAG
 * extracts, then asks, then answers), and each link is issued only once the
 * previous one resolves. `flush()` therefore drains in rounds: after a batch
 * settles it waits one idle window for those continuations to enqueue, ships
 * whatever arrived as the next batch, and returns once a window passes empty.
 * The same idle window arms an auto-flush on every `generate()`, so a caller
 * that awaits one call before issuing the next can never hang the run — it
 * just pays for more, smaller batches.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../../src/lib/judge/llm-as-judge.js';
import type { ProviderUsage } from './judge-evaluations.js';
import { TIME_MS, DURATION_MS } from '../../src/lib/core/units.js';

type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;
type MessageBatch = Anthropic.Messages.MessageBatch;
type BatchResultLine = Anthropic.Messages.MessageBatchIndividualResponse;
type MessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type GenerateResult = Awaited<ReturnType<LLMProvider['generate']>>;

/** Polling cadence while a batch is `in_progress`. */
export const BATCH_POLL_INTERVAL_MS = 25 * TIME_MS.SECOND;
/** Quiet time after the last `generate()` before the queue ships on its own. */
export const BATCH_IDLE_FLUSH_MS = DURATION_MS.FIVE_SECONDS;
/**
 * How long the run may keep batches open, measured from the first submission.
 * Every batch in the run shares it: the judge's own per-call timeout is sized
 * to cover it, so a call is bounded by the run, not by the batch it lands in.
 */
export const BATCH_WALL_CLOCK_MS = 3 * TIME_MS.HOUR;
/** Requests per Message Batch the API accepts. */
export const MAX_REQUESTS_PER_BATCH = 100_000;
/** The judge's own key wins; the shared key is the fallback. */
export const LLM_JUDGE_KEY_ENV = 'LLM_JUDGE_ANTHROPIC_KEY';
export const ANTHROPIC_KEY_ENV = 'ANTHROPIC_API_KEY';
const CUSTOM_ID_PREFIX = 'judge';
const LOG_PREFIX = '[judge-batch]';

/**
 * Why a queued request never became a message. The first three are the API's
 * own result types; `missing` is a request the results file never mentioned,
 * rejected so that no promise can wait forever.
 */
export type BatchFailureKind = 'errored' | 'expired' | 'canceled' | 'missing';

/** One batch item the API answered without a message; the judge counts it as a failed evaluation. */
export class BatchRequestFailedError extends Error {
  constructor(readonly customId: string, readonly kind: BatchFailureKind, detail?: string) {
    super(`Batch request ${customId} ${kind}${detail ? `: ${detail}` : ''}`);
    this.name = 'BatchRequestFailedError';
  }
}

/** The run's wall clock ran out with a batch still processing; the batch was cancelled and the run is over. */
export class BatchWallClockExceededError extends Error {
  constructor(readonly batchId: string, wallClockMs: number) {
    super(`Message batch ${batchId} still processing at the ${wallClockMs}ms wall clock; cancelled`);
    this.name = 'BatchWallClockExceededError';
  }
}

/** The four calls this provider makes. `client.messages.batches` satisfies it; so does a fake. */
export interface BatchClient {
  create(params: { requests: BatchRequest[] }): Promise<MessageBatch>;
  retrieve(batchId: string): Promise<MessageBatch>;
  results(batchId: string): Promise<AsyncIterable<BatchResultLine>>;
  cancel(batchId: string): Promise<MessageBatch>;
}

export interface BatchProviderOptions {
  model: string;
  maxTokens: number;
  temperature: number;
  /** Defaults to a real client built from the judge's API key. */
  client?: BatchClient;
  pollIntervalMs?: number;
  idleFlushMs?: number;
  wallClockMs?: number;
  /** Receives each succeeded result's `usage`, so batch runs feed the same totals as the sync provider. */
  onUsage?: (usage: ProviderUsage) => void;
}

export interface BatchLLMProvider extends LLMProvider {
  generate(prompt: string, options?: BatchGenerateOptions): Promise<GenerateResult>;
  /** Ship everything queued and settle every promise handed out, in as many rounds as it takes. */
  flush(): Promise<void>;
  /**
   * The error that ended the run, once one has. Set by whichever flush hit it —
   * including the idle auto-flush, which nobody awaits — so a caller that only
   * awaited its own `flush()` can still tell the run failed.
   */
  readonly failure: Error | undefined;
}

/**
 * `generate()` options. `jsonSchema` is the structured-output option a sibling
 * change adds to the judge library's `LLMProvider`; this tree's contract does
 * not carry it yet, so it is declared here and honoured by
 * {@link toOutputConfig} — the one place to touch when it lands.
 */
export type BatchGenerateOptions = NonNullable<Parameters<LLMProvider['generate']>[1]> & {
  jsonSchema?: Anthropic.Messages.JSONOutputFormat['schema'];
  /** Per-request output budget; the provider's `maxTokens` when absent. A consolidated verdict needs more than one criterion's. */
  maxTokens?: number;
};

/** Maps `jsonSchema` onto the request's `output_config.format`; nothing when the option is absent. */
export function toOutputConfig(options?: BatchGenerateOptions): Pick<MessageParams, 'output_config'> {
  if (!options?.jsonSchema) return {};
  return { output_config: { format: { type: 'json_schema', schema: options.jsonSchema } } };
}

/** The judge's own key when set, else the shared key; `undefined` lets the SDK resolve its own. */
export function resolveJudgeApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of [LLM_JUDGE_KEY_ENV, ANTHROPIC_KEY_ENV]) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function textOf(message: Anthropic.Messages.Message): string {
  return message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map(block => block.text)
    .join('');
}

interface Pending {
  resolve: (result: GenerateResult) => void;
  reject: (error: Error) => void;
}

class MessageBatchProvider implements BatchLLMProvider {
  failure: Error | undefined;
  private readonly pending = new Map<string, Pending>();
  private queued: BatchRequest[] = [];
  private sequence = 0;
  private draining: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;
  private readonly pollIntervalMs: number;
  private readonly idleFlushMs: number;
  private readonly wallClockMs: number;

  constructor(private readonly client: BatchClient, private readonly options: BatchProviderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? BATCH_POLL_INTERVAL_MS;
    this.idleFlushMs = options.idleFlushMs ?? BATCH_IDLE_FLUSH_MS;
    this.wallClockMs = options.wallClockMs ?? BATCH_WALL_CLOCK_MS;
  }

  generate(prompt: string, options?: BatchGenerateOptions): Promise<GenerateResult> {
    if (this.failure) return Promise.reject(this.failure);
    const customId = `${CUSTOM_ID_PREFIX}-${++this.sequence}`;
    const promise = new Promise<GenerateResult>((resolve, reject) => {
      this.pending.set(customId, { resolve, reject });
    });
    this.queued.push({ custom_id: customId, params: this.toParams(prompt, options) });
    this.armIdleFlush();
    return promise;
  }

  flush(): Promise<void> {
    this.disarmIdleFlush();
    if (this.failure) return Promise.reject(this.failure);
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private toParams(prompt: string, options?: BatchGenerateOptions): MessageParams {
    return {
      model: this.options.model,
      max_tokens: options?.maxTokens ?? this.options.maxTokens,
      temperature: options?.temperature ?? this.options.temperature,
      messages: [{ role: 'user', content: prompt }],
      ...toOutputConfig(options),
    };
  }

  private async drain(): Promise<void> {
    try {
      let requests = await this.awaitQueued();
      while (requests.length > 0) {
        await this.runBatch(requests);
        requests = await this.awaitQueued();
      }
    } catch (error) {
      // Whatever went wrong, nothing may be left waiting: the wall-clock path
      // has already abandoned the run, anything else does so here.
      this.abandon(toError(error));
      throw error;
    }
  }

  /**
   * One idle window, then whatever is queued. Calls issued but not yet awaited
   * land in this window — the first phase of every criterion at the start, the
   * next phase's calls after a batch settles.
   */
  private async awaitQueued(): Promise<BatchRequest[]> {
    await sleep(this.idleFlushMs);
    return this.queued.splice(0, MAX_REQUESTS_PER_BATCH);
  }

  private async runBatch(requests: BatchRequest[]): Promise<void> {
    this.startedAt ??= Date.now();
    let batch: MessageBatch;
    try {
      batch = await this.client.create({ requests });
    } catch (error) {
      // The API refused the whole batch (auth, billing, a bad request): its
      // items fail with the API's own message so the judge's failure classes
      // count them, and the run carries on.
      this.rejectAll(requests, toError(error));
      return;
    }
    while (batch.processing_status !== 'ended') {
      if (Date.now() - this.startedAt >= this.wallClockMs) {
        return this.cancelAndAbandon(batch.id);
      }
      await sleep(this.pollIntervalMs);
      try {
        batch = await this.client.retrieve(batch.id);
      } catch (error) {
        // The batch is still running server-side; a poll lost to the network
        // is simply retried next tick, and the wall clock bounds how long.
        console.warn(`${LOG_PREFIX} poll of ${batch.id} failed: ${toError(error).message}`);
      }
    }
    try {
      for await (const line of await this.client.results(batch.id)) {
        this.settleOne(line);
      }
    } catch (error) {
      this.rejectAll(requests, toError(error));
      return;
    }
    // The API writes one line per request; a request without one must not wait forever.
    for (const { custom_id } of requests) {
      this.takePending(custom_id)?.reject(new BatchRequestFailedError(custom_id, 'missing'));
    }
  }

  private settleOne({ custom_id, result }: BatchResultLine): void {
    const pending = this.takePending(custom_id);
    if (!pending) return;
    if (result.type === 'succeeded') {
      // `usage` is required on a succeeded message; only the callback is optional.
      this.options.onUsage?.(result.message.usage);
      pending.resolve({ text: textOf(result.message) });
      return;
    }
    const detail = result.type === 'errored' ? `${result.error.error.type}: ${result.error.error.message}` : undefined;
    pending.reject(new BatchRequestFailedError(custom_id, result.type, detail));
  }

  private async cancelAndAbandon(batchId: string): Promise<never> {
    const error = new BatchWallClockExceededError(batchId, this.wallClockMs);
    try {
      await this.client.cancel(batchId);
    } catch (cancelError) {
      console.warn(`${LOG_PREFIX} cancel of ${batchId} failed: ${toError(cancelError).message}`);
    }
    this.abandon(error);
    throw error;
  }

  /** Ends the run: every open promise rejects with `error`, and so does every later call. */
  private abandon(error: Error): void {
    this.failure ??= error;
    this.disarmIdleFlush();
    this.queued = [];
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private rejectAll(requests: BatchRequest[], error: Error): void {
    for (const { custom_id } of requests) this.takePending(custom_id)?.reject(error);
  }

  private takePending(customId: string): Pending | undefined {
    const pending = this.pending.get(customId);
    this.pending.delete(customId);
    return pending;
  }

  private armIdleFlush(): void {
    this.disarmIdleFlush();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      // A failure here is recorded on `failure` and rejects every open promise,
      // so there is nothing left for this unawaited path to report.
      void this.flush().catch(() => undefined);
    }, this.idleFlushMs);
  }

  private disarmIdleFlush(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

async function createBatchClient(): Promise<BatchClient> {
  // Dynamic import, as in createAnthropicProvider: a --seed run never loads the SDK.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: resolveJudgeApiKey() }).messages.batches;
}

export async function createBatchProvider(options: BatchProviderOptions): Promise<BatchLLMProvider> {
  const client = options.client ?? await createBatchClient();
  return new MessageBatchProvider(client, options);
}
