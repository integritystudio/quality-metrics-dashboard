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
 *
 * The run has a wall clock. When it runs out with a batch still processing,
 * the batch is cancelled. A cancelled batch keeps the results of the requests
 * it had already answered, readable once it reaches `ended`, so those are
 * settled like any others and only the remainder is abandoned. That is the
 * run's deadline, not a failure: `flush()` resolves and the caller keeps every
 * result that came back (JUDGE-BATCH-WALLCLOCK-ABORTS-RUN).
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider } from '../../src/lib/judge/llm-as-judge.js';
import type { ProviderUsage } from './judge-evaluations.js';
import { TIME_MS, DURATION_MS } from '../../src/lib/core/units.js';
import { createJudgeAnthropicClient } from './judge-anthropic-client.js';
import { resolveJudgeApiKey } from './judge-credentials.js';
import { sleep } from './sleep.js';

type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;
type MessageBatch = Anthropic.Messages.MessageBatch;
type BatchResultLine = Anthropic.Messages.MessageBatchIndividualResponse;
type MessageParams = Anthropic.Messages.MessageCreateParamsNonStreaming;
type GenerateResult = Awaited<ReturnType<LLMProvider['generate']>>;

/** Polling cadence while a batch is `in_progress`. */
export const BATCH_POLL_INTERVAL_MS = 25 * TIME_MS.SECOND;
/** Quiet time after the last `generate()` before the queue ships on its own. */
const BATCH_IDLE_FLUSH_MS = DURATION_MS.FIVE_SECONDS;
/**
 * How long the run may keep batches open, measured from the first submission.
 * Every batch in the run shares it: the judge's own per-call timeout is sized
 * to cover it, so a call is bounded by the run, not by the batch it lands in.
 */
export const BATCH_WALL_CLOCK_MS = 3 * TIME_MS.HOUR;
/**
 * How long a batch cancelled at the wall clock gets to reach `ended`, which is
 * when the results of the requests it had already answered become readable.
 * The API finishes the requests it cannot interrupt before it ends the batch,
 * and documents no limit on how long that takes; this is the limit. Past it
 * the batch's results go unread and every open request is abandoned.
 */
export const BATCH_CANCEL_GRACE_MS = DURATION_MS.TEN_MINUTES;
/** Requests per Message Batch the API accepts. */
const MAX_REQUESTS_PER_BATCH = 100_000;
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

/**
 * The run's wall clock ran out with a batch still processing. The batch was
 * cancelled and the run is over: every request left unanswered rejects with
 * this, and so does every later `generate()`.
 */
export class BatchWallClockExceededError extends Error {
  /**
   * Requests rejected with this error: the ones the cancelled batch never
   * answered, and any queued behind it. Counted once the batch's own results
   * have been settled.
   */
  abandoned = 0;
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
  /** How long a batch cancelled at the wall clock gets to end; `BATCH_CANCEL_GRACE_MS` when absent. */
  cancelGraceMs?: number;
  /** Receives each succeeded result's `usage`, so batch runs feed the same totals as the sync provider. */
  onUsage?: (usage: ProviderUsage) => void;
}

export interface BatchLLMProvider extends LLMProvider {
  generate(prompt: string, options?: BatchGenerateOptions): Promise<GenerateResult>;
  /**
   * Ship everything queued and settle every promise handed out, in as many
   * rounds as it takes. Running out of wall clock does not reject it: by then
   * every promise is settled, the abandoned ones with
   * {@link BatchWallClockExceededError}.
   */
  flush(): Promise<void>;
  /**
   * The error that broke the run, once one has. Set by whichever flush hit it —
   * including the idle auto-flush, which nobody awaits — so a caller that only
   * awaited its own `flush()` can still tell the run failed. The wall clock is
   * a deadline, not a failure, and never sets it.
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
  /** Set when the wall clock runs out; from then on the run takes no new requests. */
  private overrun: BatchWallClockExceededError | undefined;
  private readonly pending = new Map<string, Pending>();
  private queued: BatchRequest[] = [];
  private sequence = 0;
  private draining: Promise<void> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt: number | undefined;
  private readonly pollIntervalMs: number;
  private readonly idleFlushMs: number;
  private readonly wallClockMs: number;
  private readonly cancelGraceMs: number;

  constructor(private readonly client: BatchClient, private readonly options: BatchProviderOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? BATCH_POLL_INTERVAL_MS;
    this.idleFlushMs = options.idleFlushMs ?? BATCH_IDLE_FLUSH_MS;
    this.wallClockMs = options.wallClockMs ?? BATCH_WALL_CLOCK_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? BATCH_CANCEL_GRACE_MS;
  }

  generate(prompt: string, options?: BatchGenerateOptions): Promise<GenerateResult> {
    const over = this.failure ?? this.overrun;
    if (over) return Promise.reject(over);
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
      // Whatever went wrong, nothing may be left waiting. Running out of wall
      // clock does not come through here: that path settles every promise
      // itself and returns.
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
        return this.closeAtWallClock(batch.id);
      }
      await sleep(this.pollIntervalMs);
      batch = await this.poll(batch);
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
    // Guard: if onUsage or textOf throws, the entry is already removed from
    // pending. Without this catch the promise would never settle.
    try {
      if (result.type === 'succeeded') {
        // `usage` is required on a succeeded message; only the callback is optional.
        this.options.onUsage?.(result.message.usage);
        pending.resolve({ text: textOf(result.message) });
        return;
      }
      const detail = result.type === 'errored' ? `${result.error.error.type}: ${result.error.error.message}` : undefined;
      pending.reject(new BatchRequestFailedError(custom_id, result.type, detail));
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** The batch as the API now reports it. A poll lost to the network returns the last state seen. */
  private async poll(batch: MessageBatch): Promise<MessageBatch> {
    try {
      return await this.client.retrieve(batch.id);
    } catch (error) {
      // The batch is still running server-side; a poll lost to the network
      // is simply retried next tick, and the wall clock bounds how long.
      console.warn(`${LOG_PREFIX} poll of ${batch.id} failed: ${toError(error).message}`);
      return batch;
    }
  }

  /**
   * The wall clock ran out with `batchId` still processing: cancel it, settle
   * what it had already answered, and abandon the rest. That ends the run
   * without failing it, so the caller keeps every result that came back.
   */
  private async closeAtWallClock(batchId: string): Promise<void> {
    const overrun = new BatchWallClockExceededError(batchId, this.wallClockMs);
    // Recorded first, so a call that follows from a result settled below is
    // refused instead of queued for a batch that will never ship.
    this.overrun = overrun;
    const open = this.pending.size;
    if (await this.cancelAndAwaitEnd(batchId)) await this.settleAnswered(batchId);
    const settled = open - this.pending.size;
    overrun.abandoned = this.rejectOpen(overrun);
    console.warn(`${LOG_PREFIX} ${overrun.message}; settled ${settled} results it had already produced, abandoned ${overrun.abandoned} requests`);
  }

  /**
   * Cancels the batch and waits for the cancellation to finish. The results of
   * a cancelled batch are readable only once it reaches `ended`; true when it
   * got there within the grace.
   */
  private async cancelAndAwaitEnd(batchId: string): Promise<boolean> {
    let batch: MessageBatch;
    try {
      batch = await this.client.cancel(batchId);
    } catch (error) {
      console.warn(`${LOG_PREFIX} cancel of ${batchId} failed: ${toError(error).message}`);
      return false;
    }
    const deadline = Date.now() + this.cancelGraceMs;
    while (batch.processing_status !== 'ended' && Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      batch = await this.poll(batch);
    }
    if (batch.processing_status === 'ended') return true;
    console.warn(`${LOG_PREFIX} ${batchId} had not ended ${this.cancelGraceMs}ms after the cancel; its results go unread`);
    return false;
  }

  /**
   * Settles the lines a cancelled batch answered: a message, or the API's own
   * error. A `canceled` line is a request it never ran, and never billed; that
   * one stays open, to be abandoned with the rest.
   */
  private async settleAnswered(batchId: string): Promise<void> {
    try {
      for await (const line of await this.client.results(batchId)) {
        if (line.result.type === 'succeeded' || line.result.type === 'errored') this.settleOne(line);
      }
    } catch (error) {
      console.warn(`${LOG_PREFIX} results of ${batchId} could not be read: ${toError(error).message}`);
    }
  }

  /** Fails the run: every open promise rejects with `error`, and so does every later call. */
  private abandon(error: Error): void {
    this.failure ??= error;
    this.rejectOpen(error);
  }

  /** Rejects every open promise with `error` and drops the queue. Returns how many promises that was. */
  private rejectOpen(error: Error): number {
    this.disarmIdleFlush();
    this.queued = [];
    const open = this.pending.size;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    return open;
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
  return (await createJudgeAnthropicClient({ apiKey: resolveJudgeApiKey()?.apiKey })).messages.batches;
}

export async function createBatchProvider(options: BatchProviderOptions): Promise<BatchLLMProvider> {
  const client = options.client ?? await createBatchClient();
  return new MessageBatchProvider(client, options);
}
