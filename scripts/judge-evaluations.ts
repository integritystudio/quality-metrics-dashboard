#!/usr/bin/env tsx
/**
 * LLM-as-Judge Evaluation Generator
 *
 * Discovers session transcripts, extracts user/assistant turns, and evaluates
 * them using the LLM-as-Judge library (relevance, coherence, hallucination)
 * via the Anthropic API (Claude Haiku).
 *
 * Discovery takes the sessions, each turn's account and the already-judged set
 * from obtool-api (judge-cloud-source.ts) over the last `JUDGE_DEFAULT_DAYS`
 * unless `--date=`/`--days=` says otherwise, the same window populate passes.
 * `--source=local` reads local telemetry logs instead, kept for one release
 * as the rollback. Turn text is always read
 * from the local transcripts. Judged, withheld and held-for-key turns are
 * dropped before `--limit` (judge-selection.ts).
 *
 * Results are posted straight to ingest (post-evaluations.ts) and appended to
 * `evaluations-<today>.jsonl`, the ledger the local source dedups against.
 *
 * Usage:
 *   npx tsx dashboard/scripts/judge-evaluations.ts --dry-run
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts --limit 5
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts --batch   # Message Batches API: half price, unattended
 *   ANTHROPIC_API_KEY=sk-... npx tsx dashboard/scripts/judge-evaluations.ts --per-criterion   # one call per criterion (~10x cost)
 *   npx tsx dashboard/scripts/judge-evaluations.ts --dry-run --source=local   # the rollback: local discovery, every log file
 *   npx tsx dashboard/scripts/judge-evaluations.ts --backfill   # synthetic scores for trace-only sessions; see below
 *
 * `--backfill` (run by hand, no other flag applies) seeds hashed scores for
 * sessions with traces but no transcript, into the local ledger only, under
 * cohort `backfill` (canary draws stay `canary`). That cohort is not evidence
 * (`isEvidenceCohort`), but a row young enough for upload's age guard still
 * reaches sync's `metric:*` keys, which drop only canaries.
 *
 * Scoring is consolidated by default, one call per turn carrying every
 * criterion (judge-consolidated.ts); `--batch` applies to either mode.
 *
 * LLM_JUDGE_ANTHROPIC_KEY, when set, is used instead of ANTHROPIC_API_KEY so
 * judge spend is attributable to its own key (see judge-credentials.ts).
 */

import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, openSync, closeSync, statSync, constants } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import type AnthropicSdk from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import type { LLMProvider, ResponseJsonSchema, QagVerificationMode } from '../../src/lib/judge/llm-as-judge.js';
import { LLMJudge, COHERENCE_CRITERIA } from '../../src/lib/judge/llm-judge-config.js';
import { HALLUCINATION_EVAL_NAME, LLM_EVALUATOR_TYPE, type EvaluatorKind, type EvaluationCohort } from '../../src/lib/validation/dashboard-schemas.js';
import { TIME_MS } from '../../src/lib/core/units.js';
import { TELEMETRY_DIR, CANARY_COHORT } from './evaluation-constants.js';
import { JUDGE_EXIT_POST_FAILED, JUDGE_EXIT_DISCOVERY_FAILED, JUDGE_BATCH_FLAG, JUDGE_DEFAULT_DAYS, JUDGE_DEFAULT_SOURCE, JUDGE_LIMIT_FLAG, JUDGE_PER_CRITERION_FLAG, JUDGE_SEED_FLAG, DRY_RUN_FLAG, type TraceSource } from './pipeline-stages.js';
import { exitOnCliArgError, parseCli, positiveIntArg, runIfMain, type CliSpec } from './cli-args.js';
import {
  createBatchProvider,
  BATCH_CANCEL_GRACE_MS,
  BATCH_POLL_INTERVAL_MS,
  BATCH_WALL_CLOCK_MS,
  type BatchLLMProvider,
} from './judge-batch-provider.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { resolveJudgeApiKey, JUDGE_API_KEY_ENV, DEFAULT_API_KEY_ENV, type JudgeApiKey } from './judge-credentials.js';
import { ACCOUNT_INDEX_WINDOW_DAYS, buildAccountIndex, type AccountIndex } from './account-stamps.js';
import { createJudgeAnthropicClient, jsonSchemaOutputConfig, responseText } from './judge-anthropic-client.js';
import { sleep } from './sleep.js';
import { incrementIn } from './collections.js';
import { discoverFromCloud } from './judge-cloud-source.js';
import { createConsolidatedTurnEvaluator, evaluateTurnsConsolidatedBatched } from './judge-consolidated.js';
import { readScope, resolveDateScope, resolveSource } from './derive-evaluations.js';
import { selectTurns, formatTurnSelection } from './judge-selection.js';
import { formatPostSummary, postEvaluationRecords } from './post-evaluations.js';
import {
  BACKFILL_COHORT,
  LLM_EVALUATOR_KIND,
  NORMAL_COHORT,
  PRODUCER,
  SCORE_PREVIEW_DECIMALS,
  SEED_COHORT,
  SESSION_ID_PREVIEW_LEN,
  SYNTHETIC_EVALUATOR_KIND,
  TRACE_BACKFILL_EVALUATOR_TYPE,
  EVAL_SCORE_PRECISION,
  legacyEvaluatorType,
  normalizeScore,
  toOTelRecord,
  type EvalRecord,
} from './eval-record.js';
import {
  COHERENCE_EVAL_NAME,
  FAITHFULNESS_EVAL_NAME,
  HAIKU_MODEL,
  JUDGE_DEFAULT_TEMPERATURE,
  JUDGE_MAX_TOKENS,
  QAG_MODE_RECORDS,
  RELEVANCE_EVAL_NAME,
  TOOL_ARGUMENTS_CRITERIA,
  TOOL_CORRECTNESS_CRITERIA,
  TOOL_INTEGRATION_CRITERIA,
  TOOL_SELECTION_CRITERIA,
} from './judge-criteria.js';
import { _loadExistingKeys, judgedByKey, turnKeyOf, turnScoreKey } from './judge-dedup.js';
import {
  _discoverTranscripts,
  anchorTurns,
  discoverSessionsFromTraces,
  extractTurns,
  fitContextForJudge,
  turnSourceFields,
  type Turn,
} from './judge-turns.js';
import {
  addUsage,
  createUsageTotals,
  estimateJudgeRun,
  toJudgeTokenUsage,
  type JudgeTokenUsage,
  type ProviderUsage,
} from './judge-usage.js';
import { evalFailures, failureClasses, readRunState, resetFailureTracking, summarizeJudgeRun, trackFailure, writeRunState } from './judge-failures.js';
import { EVALUATIONS_FILE_PREFIX, datedJsonlName } from './telemetry-files.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';

const CONCURRENCY = 3;
const BATCH_DELAY_MS = 500;
/**
 * --batch: the judge's per-call budget must outlast the provider's wall clock,
 * the grace it gives the batch it cancels there to hand back what it had
 * already answered, and the poll that notices. Then an overrun surfaces as
 * the provider's typed error rather than as a per-call timeout, and a result
 * settled inside the grace still reaches its call.
 */
export const BATCH_MODE_JUDGE_TIMEOUT_MS = BATCH_WALL_CLOCK_MS + BATCH_CANCEL_GRACE_MS + BATCH_POLL_INTERVAL_MS;
/** --batch: a retry would land in a later batch and double the wait; a failed item is counted, not retried. */
export const BATCH_MODE_MAX_RETRIES = 0;
/** Synchronous path: retries per judge call before the item counts as failed. */
const SYNC_MODE_MAX_RETRIES = 2;
/** Sessions listed in a --dry-run's turn-count breakdown. */
const DRY_RUN_TOP_SESSIONS = 10;

const MAX_TURN_LIMIT = 10_000;

/**
 * Build one record.
 *
 * `kind` and `cohort` are separate arguments on purpose (OBP16), so a hashed
 * canary score can never be written as a judged one. `judgeModel` is omitted
 * for any score no model produced.
 */
function createEvalRecord(
  turn: Turn,
  evaluationName: string,
  scoreValue: number,
  explanation: string,
  kind: EvaluatorKind,
  cohort: EvaluationCohort,
  judgeModel?: string,
): EvalRecord {
  return {
    timestamp: turn.timestamp,
    evaluationName,
    scoreValue: normalizeScore(scoreValue),
    explanation,
    evaluator: PRODUCER,
    // Narrowed to the kind axis; the cohort has its own field now.
    ...(legacyEvaluatorType(kind) && { evaluatorType: legacyEvaluatorType(kind) }),
    evaluatorKind: kind,
    cohort,
    ...(judgeModel && { judgeModel }),
    traceId: turn.traceId,
    sessionId: turn.sessionId,
    ...turnSourceFields(turn),
  };
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------
// The dry-run's TOKENS_PER_CHAR estimate is not what a run costs. Every
// response carries `usage`; the provider folds each one into the totals the
// summary line prints beside the estimate.


/** The slice of the SDK client the judge provider calls; a test passes a fake. */
export type JudgeMessagesClient = {
  messages: {
    create(params: AnthropicSdk.MessageCreateParamsNonStreaming): Promise<Pick<AnthropicSdk.Message, 'content'> & { usage?: ProviderUsage }>;
  };
};


/** The judge's synchronous provider; `onUsage` also sees each response's usage, which the one-shot evals total. */
export async function createAnthropicProvider(
  apiKey: string,
  usage: JudgeTokenUsage = createUsageTotals(),
  onUsage?: (usage: JudgeTokenUsage) => void,
): Promise<LLMProvider> {
  return anthropicProviderFor(await createJudgeAnthropicClient({ apiKey }), usage, onUsage);
}

/** The judge's provider over an SDK client, or a fake one in tests. */
export function anthropicProviderFor(
  client: JudgeMessagesClient,
  usage: JudgeTokenUsage = createUsageTotals(),
  onUsage?: (usage: JudgeTokenUsage) => void,
): LLMProvider {
  return {
    async generate(
      prompt: string,
      options?: { temperature?: number; logprobs?: boolean; jsonSchema?: ResponseJsonSchema }
    ): Promise<{ text: string; logprobs?: Array<{ token: string; logprob: number }> }> {
      const response = await client.messages.create({
        model: HAIKU_MODEL,
        // The backstop for a schema-constrained reply (reasoning plus score); never below 512.
        max_tokens: JUDGE_MAX_TOKENS,
        temperature: options?.temperature ?? JUDGE_DEFAULT_TEMPERATURE,
        messages: [{ role: 'user', content: prompt }],
        ...jsonSchemaOutputConfig(options?.jsonSchema),
      });
      if (response.usage) {
        const seen = toJudgeTokenUsage(response.usage);
        addUsage(usage, seen);
        onUsage?.(seen);
      }

      const text = responseText(response.content);

      // Anthropic Messages API doesn't support logprobs, so G-Eval
      // falls back to text-parsed scores. This may cause score clustering
      // around round numbers (0.7, 0.8) due to lack of logprob calibration.
      return { text };
    },
  };
}

/** The pipeline's LLMJudge. The one-shot evals build theirs here too, so their config cannot drift from it. */
export function createLLMJudge(llm: LLMProvider, batch = false): LLMJudge {
  return new LLMJudge(llm, {
    timeoutMs: batch ? BATCH_MODE_JUDGE_TIMEOUT_MS : TIME_MS.MINUTE,
    maxRetries: batch ? BATCH_MODE_MAX_RETRIES : SYNC_MODE_MAX_RETRIES,
    evaluator: PRODUCER,
    evaluatorType: LLM_EVALUATOR_TYPE,
    logger: {
      warn: (msg) => console.warn(`  [warn] ${msg}`),
      error: (msg) => console.error(`  [error] ${msg}`),
    },
  });
}

/** Largest value of the two hash bytes a seeded score is read from. */
const UINT16_MAX = 0xFFFF;
/** Share of turns `isCanaryTurn` marks for intentionally low scores. */
const CANARY_TURN_RATE = 0.02;

export function hashToScore(input: string, min: number, max: number): number {
  const hash = createHash('sha256').update(input).digest();
  const value = hash.readUInt16BE(0) / UINT16_MAX;
  return normalizeScore(min + value * (max - min));
}

/** Deterministic canary check — ~2% of turns get intentionally low scores */
export function isCanaryTurn(sessionId: string, turnKey: string): boolean {
  return hashToScore(`canary:${sessionId}:${turnKey}`, 0, 1) < CANARY_TURN_RATE;
}

export interface SeedResult {
  evals: EvalRecord[];
  canaryCount: number;
}

type ScoreRange = readonly [min: number, max: number];

interface SeedMetric {
  evalName: string;
  label: string;
  /** Prefix of the hashed input, so each metric draws its own score. */
  hashKey: string;
  normal: ScoreRange;
  canary: ScoreRange;
  /** Seeded only for turns with tool results. */
  needsTools?: boolean;
}

/** Hallucination's draw; faithfulness is seeded as its complement. */
const SEED_HALLUCINATION: SeedMetric = {
  evalName: HALLUCINATION_EVAL_NAME, label: 'Hallucination', hashKey: 'hal', normal: [0.0, 0.09], canary: [0.50, 0.80],
};

/** In record order. */
const SEED_METRICS: readonly SeedMetric[] = [
  { evalName: RELEVANCE_EVAL_NAME, label: 'Relevance', hashKey: 'rel', normal: [0.70, 1.0], canary: [0.10, 0.35] },
  { evalName: COHERENCE_EVAL_NAME, label: 'Coherence', hashKey: 'coh', normal: [0.75, 1.0], canary: [0.15, 0.40] },
  { ...SEED_HALLUCINATION, evalName: FAITHFULNESS_EVAL_NAME, label: 'Faithfulness' },
  SEED_HALLUCINATION,
  { evalName: TOOL_CORRECTNESS_CRITERIA.name, label: 'Tool correctness', hashKey: 'tc', normal: [0.75, 1.0], canary: [0.10, 0.30], needsTools: true },
];

export function seedEvaluations(turns: Turn[], existingKeys: Set<string>): SeedResult {
  const evals: EvalRecord[] = [];
  let canaryCount = 0;

  for (const turn of turns) {
    const turnKey = turnKeyOf(turn.timestamp);
    const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
    const canary = isCanaryTurn(turn.sessionId, turnKey);
    if (canary) canaryCount++;

    for (const metric of SEED_METRICS) {
      if (metric.needsTools && turn.toolResults.length === 0) continue;
      if (existingKeys.has(turnScoreKey(turn.sessionId, metric.evalName, turnKey))) continue;
      const [min, max] = canary ? metric.canary : metric.normal;
      const drawn = hashToScore(`${metric.hashKey}:${turn.sessionId}:${turnKey}`, min, max);
      const score = metric.evalName === FAITHFULNESS_EVAL_NAME ? normalizeScore(1 - drawn) : drawn;
      evals.push(createEvalRecord(
        turn,
        metric.evalName,
        score,
        `${metric.label} (${canary ? 'canary' : 'seeded'}) for session ${sessionPreview}`,
        SYNTHETIC_EVALUATOR_KIND,
        canary ? CANARY_COHORT : SEED_COHORT,
      ));
    }
  }

  return { evals, canaryCount };
}

export interface EvaluateTurnOptions {
  /**
   * Issue every criterion at once instead of one after another. Required by
   * the batch provider, whose calls resolve only when the batch does: awaiting
   * the first criterion before issuing the second would wait on a batch that
   * cannot ship until the second is queued.
   */
  concurrent?: boolean;
}

export async function evaluateTurn(
  judge: LLMJudge,
  turn: Turn,
  existingKeys: Set<string>,
  options: EvaluateTurnOptions = {},
): Promise<EvalRecord[]> {
  const evals: EvalRecord[] = [];
  const turnKey = turnKeyOf(turn.timestamp);
  const sessionPreview = turn.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
  const toolContext = fitContextForJudge(turn.toolResults);
  // Every criterion catches its own failure, so a collected promise can only
  // fulfil; the allSettled at the end is the guard, not the error path.
  const inFlight: Promise<void>[] = [];
  const score = (criterion: () => Promise<void>): Promise<void> => {
    if (!options.concurrent) return criterion();
    inFlight.push(criterion());
    return Promise.resolve();
  };

  const isJudged = (evalName: string): boolean =>
    existingKeys.has(judgedByKey(turn.sessionId, evalName, turnKey, HAIKU_MODEL));
  const record = (evalName: string, value: number, reason: string): void => {
    evals.push(createEvalRecord(turn, evalName, value, reason, LLM_EVALUATOR_KIND, NORMAL_COHORT, HAIKU_MODEL));
  };
  const fail = (evalName: string, err: unknown): void => trackFailure(evalName, err, sessionPreview);
  const fallbackReason = (label: string, value: number): string =>
    `${label}: ${value.toFixed(SCORE_PREVIEW_DECIMALS)} for session ${sessionPreview}`;
  /** One criterion, unless already judged; a failure is tracked and logged, never thrown. */
  const scoreCriterion = (
    evalName: string,
    label: string,
    run: () => Promise<{ score: number; reason?: string }>,
  ): Promise<void> => {
    if (isJudged(evalName)) return Promise.resolve();
    return score(async () => {
      try {
        const result = await run();
        record(evalName, result.score, result.reason ?? fallbackReason(label, result.score));
      } catch (err) {
        fail(evalName, err);
      }
    });
  };

  await scoreCriterion(RELEVANCE_EVAL_NAME, 'Relevance',
    () => judge.evaluateRelevance(turn.userText, turn.assistantText, toolContext));
  await scoreCriterion(COHERENCE_EVAL_NAME, 'Coherence',
    () => judge.gEval(COHERENCE_CRITERIA, { input: turn.userText, output: turn.assistantText }));

  if (turn.toolResults.length > 0) {
    // One QAG sweep answers both. 'faithfulness' counts the statements the tool
    // results support; 'fabrication' counts the ones they contradict — and the two
    // do not sum to 1, because a statement the context cannot settle belongs to
    // neither, so hallucination is not `1 - faithfulness`.
    const qagModes: QagVerificationMode[] = [
      ...(isJudged(FAITHFULNESS_EVAL_NAME) ? [] : (['faithfulness'] as const)),
      ...(isJudged(HALLUCINATION_EVAL_NAME) ? [] : (['fabrication'] as const)),
    ];
    if (qagModes.length > 0) await score(async () => {
      try {
        const { scores } = await judge.qagEvaluateModes(turn.userText, turn.assistantText, toolContext, qagModes);
        for (const mode of qagModes) {
          const { evalName, label } = QAG_MODE_RECORDS[mode];
          record(evalName, scores[mode], fallbackReason(label, scores[mode]));
        }
      } catch (err) {
        // The sweep is shared, so its failure is every requested mode's failure —
        // counting it once would under-report the metric that asked for it too.
        for (const mode of qagModes) fail(QAG_MODE_RECORDS[mode].evalName, err);
      }
    });

    if (!isJudged(TOOL_CORRECTNESS_CRITERIA.name)) {
      const tcTestCase = { input: turn.userText, output: turn.assistantText, context: toolContext };
      await scoreCriterion(TOOL_CORRECTNESS_CRITERIA.name, 'Tool correctness',
        () => judge.gEval(TOOL_CORRECTNESS_CRITERIA, tcTestCase));
      for (const config of [TOOL_SELECTION_CRITERIA, TOOL_ARGUMENTS_CRITERIA, TOOL_INTEGRATION_CRITERIA]) {
        await scoreCriterion(config.name, config.name, () => judge.gEval(config, tcTestCase));
      }
    }
  }

  await Promise.allSettled(inFlight);
  return evals;
}

/**
 * The --batch path. Every turn's criteria are issued at once — nothing awaits a
 * result before the batch ships — then one flush() submits them and settles
 * every promise; the calls a criterion issues after that (G-Eval's scoring
 * step, QAG's questions and answers) ride the provider's later rounds and its
 * idle auto-flush. Running out of wall clock is not thrown: the provider
 * settles what the batch it cancels had already answered and rejects the
 * rest, so each turn comes back with the records that were scored and its
 * other criteria counted as `wall-clock` failures. Only a provider `failure`
 * throws.
 */
export async function evaluateTurnsBatched(
  provider: BatchLLMProvider,
  judge: LLMJudge,
  turns: Turn[],
  existingKeys: Set<string>,
): Promise<EvalRecord[][]> {
  const inFlight = turns.map(turn => evaluateTurn(judge, turn, existingKeys, { concurrent: true }));
  await provider.flush();
  const perTurn = await Promise.all(inFlight);
  if (provider.failure) throw provider.failure;
  return perTurn;
}

export interface TurnDiscovery {
  /** Anchored, then restricted to the date scope when there is one. */
  turns: Turn[];
  /** The index the turns were anchored with; it also routes their posts. */
  accounts: AccountIndex;
  /** The already-judged set: the cloud's rows, or the local ledger read on call. */
  loadExistingKeys: () => Set<string>;
}

/**
 * Find the turns a run may judge. `local` reads telemetry logs and trace files
 * and dedups against the local ledger; `cloud` takes all three from obtool-api
 * (judge-cloud-source.ts) and needs a date scope. Turn text is local either way.
 */
export async function discoverTurns(source: TraceSource, dateScope: ReadonlySet<string> | null): Promise<TurnDiscovery> {
  if (source === 'cloud' && !dateScope) throw new Error('the cloud source needs a date scope');
  const cloud = source === 'cloud' && dateScope
    ? await discoverFromCloud(dateScope)
    : undefined;
  const transcripts = cloud?.transcripts ?? await _discoverTranscripts();

  const concurrencyLimit = pLimit(CONCURRENCY);
  const turnArrays = await Promise.all(transcripts.map(info => concurrencyLimit(() => extractTurns(info))));
  // Anchored before the scope and the limit cut, so each turn's window is
  // bounded by the real next turn rather than by whichever turns survived.
  const extracted = turnArrays.flat();
  const accounts = cloud?.accounts ?? buildAccountIndex(TELEMETRY_DIR, ACCOUNT_INDEX_WINDOW_DAYS, Date.now());
  anchorTurns(extracted, accounts);
  return {
    turns: dateScope ? extracted.filter(t => dateScope.has(toDateOnly(t.timestamp))) : extracted,
    accounts,
    loadExistingKeys: () => cloud?.existingKeys ?? _loadExistingKeys(),
  };
}

const LOCK_FILE = join(TELEMETRY_DIR, '.judge-evaluations.lock');

/** Lock file mode: owner read/write only. */
const LOCK_FILE_MODE = 0o600;

/** Create the lock file holding this pid, atomically (O_CREAT | O_EXCL); false when it already exists. */
function tryCreateLock(): boolean {
  try {
    const fd = openSync(LOCK_FILE, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, LOCK_FILE_MODE);
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/** Whether the pid in the lock file belongs to a live process (EPERM: alive, not ours to signal). */
function lockOwnerAlive(): boolean {
  const lockPid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
  if (isNaN(lockPid) || lockPid <= 0) return false;
  try {
    process.kill(lockPid, 0);
    return true;
  } catch (killErr) {
    return (killErr as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stale if older than {@link TIME_MS.HOUR}, whatever its pid says. */
function lockExpired(): boolean {
  try {
    const lockAgeMs = Date.now() - statSync(LOCK_FILE).mtimeMs;
    if (lockAgeMs <= TIME_MS.HOUR) return false;
    console.warn(`[judge] Lock file is ${Math.round(lockAgeMs / TIME_MS.MINUTE)}min old, treating as stale`);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (tryCreateLock()) return true;
  try {
    if (!existsSync(LOCK_FILE) || lockOwnerAlive()) return false;
  } catch {
    return false;
  }
  if (!lockExpired()) return false;
  // Remove the stale lock and re-acquire atomically; losing the race means another process holds it.
  try { unlinkSync(LOCK_FILE); } catch { /* another process may have removed it */ }
  return tryCreateLock();
}

/** Take the lock or exit 1: two runs must not append to the ledger at once. */
function acquireLockOrExit(): void {
  if (acquireLock()) return;
  console.error('Error: Another judge-evaluations process is running (lockfile exists)');
  process.exit(1);
}

function releaseLock(): void {
  try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}


/** Append to today's file and return its path; each record keeps its turn time. */
function writeEvaluations(evals: EvalRecord[]): string {
  const today = toDateOnly(new Date());
  const outFile = join(TELEMETRY_DIR, datedJsonlName(EVALUATIONS_FILE_PREFIX, today));
  const content = evals.map(e => JSON.stringify(toOTelRecord(e))).join('\n') + '\n';
  appendFileSync(outFile, content);
  return outFile;
}

export async function processBatch<T, R>(
  items: T[],
  concurrency: number,
  delayMs: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = pLimit(concurrency);
  const settled = await Promise.allSettled(
    items.map(item => limit(async () => {
      const result = await fn(item);
      if (delayMs > 0) await sleep(delayMs);
      return result;
    })),
  );
  return settled.filter(r => r.status === 'fulfilled').map(r => r.value);
}

/** --backfill: seed evaluations from trace data for sessions with no transcript (see the file header). */
async function runBackfill(): Promise<void> {
  const traceTurns = await discoverSessionsFromTraces();
  anchorTurns(traceTurns, buildAccountIndex(TELEMETRY_DIR, ACCOUNT_INDEX_WINDOW_DAYS, Date.now()));
  console.log(`[backfill] Discovered ${traceTurns.length} sessions from trace files`);

  acquireLockOrExit();

  try {
    const existingKeys = _loadExistingKeys();

    // Checking only hallucination would skip sessions with partial coverage.
    const newTurns = traceTurns.filter(t => {
      const turnKey = turnKeyOf(t.timestamp);
      return SEED_METRICS.some(m => !m.needsTools && !existingKeys.has(turnScoreKey(t.sessionId, m.evalName, turnKey)));
    });
    console.log(`[backfill] ${newTurns.length} sessions need evaluations (${traceTurns.length - newTurns.length} already covered)`);

    if (newTurns.length === 0) return;

    const seedResult = seedEvaluations(newTurns, existingKeys);
    // Backfilled data is not organic seed, so re-cohort it; the cohort axis
    // owns this (OBP16).
    for (const ev of seedResult.evals) {
      if (ev.cohort === SEED_COHORT) {
        ev.cohort = BACKFILL_COHORT;
        ev.evaluatorType = TRACE_BACKFILL_EVALUATOR_TYPE;
      }
    }

    if (seedResult.evals.length > 0) {
      writeEvaluations(seedResult.evals);
      const byCat = new Map<string, number>();
      for (const ev of seedResult.evals) {
        incrementIn(byCat, ev.evaluationName);
      }
      console.log(`[backfill] Wrote ${seedResult.evals.length} evaluations:`);
      for (const [name, count] of byCat) {
        console.log(`  ${name}: ${count}`);
      }
    }
  } finally {
    releaseLock();
  }
}

/** --dry-run: what a run over `allTurns` would cost, and where its turns come from. */
function printDryRun(allTurns: Turn[], batch: boolean, consolidated: boolean): void {
  const est = estimateJudgeRun(allTurns, batch, consolidated);

  console.log(`[dry-run] ${allTurns.length} turns → ${est.evals} ${consolidated ? 'consolidated calls' : 'evals'}`);
  console.log(`[dry-run] ~${est.inputTokens.toLocaleString()} input tokens, ~${est.outputTokens.toLocaleString()} output tokens`);
  console.log(`[dry-run] estimated cost: $${est.costUsd.toFixed(EVAL_SCORE_PRECISION)}${batch ? ' (batch rate, 50% off list)' : ''}`);

  const bySession = new Map<string, number>();
  for (const t of allTurns) {
    const sid = t.sessionId.slice(0, SESSION_ID_PREVIEW_LEN);
    incrementIn(bySession, sid);
  }
  const sorted = [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, DRY_RUN_TOP_SESSIONS);
  console.log('[dry-run] top sessions by turn count:');
  for (const [sid, count] of sorted) {
    console.log(`  ${sid}: ${count} turns`);
  }
}

/**
 * Score `allTurns` with the LLM judge — consolidated unless --per-criterion,
 * through the Message Batches API under --batch — and report the run's
 * summary, setting a failing exit code when it flags one.
 */
async function judgeTurns(
  allTurns: Turn[],
  existingKeys: Set<string>,
  judgeKey: JudgeApiKey,
  { batch, consolidated }: { batch: boolean; consolidated: boolean },
): Promise<EvalRecord[]> {
  const estimatedUsd = estimateJudgeRun(allTurns, batch, consolidated).costUsd;
  const usage = createUsageTotals();
  const batchProvider = batch
    ? await createBatchProvider({
        model: HAIKU_MODEL,
        maxTokens: JUDGE_MAX_TOKENS,
        temperature: JUDGE_DEFAULT_TEMPERATURE,
        onUsage: (u) => addUsage(usage, u),
      })
    : undefined;
  const llm = batchProvider ?? await createAnthropicProvider(judgeKey.apiKey, usage);
  const judge = createLLMJudge(llm, batchProvider !== undefined);
  // Consolidated (the default): one call per turn, judge-consolidated.ts. Its
  // synchronous provider gets the judge key and the run's usage totals, so it
  // bills and reports exactly as the per-criterion path does; under --batch
  // it rides the same batch provider (JCP3).
  let allEvals: EvalRecord[][];
  if (batchProvider) {
    allEvals = consolidated
      ? await evaluateTurnsConsolidatedBatched(batchProvider, allTurns, existingKeys)
      : await evaluateTurnsBatched(batchProvider, judge, allTurns, existingKeys);
  } else {
    const evaluate = consolidated
      ? await createConsolidatedTurnEvaluator(existingKeys, {
          apiKey: judgeKey.apiKey,
          onUsage: (u) => addUsage(usage, u),
        })
      : (turn: Turn) => evaluateTurn(judge, turn, existingKeys);
    allEvals = await processBatch(allTurns, CONCURRENCY, BATCH_DELAY_MS, evaluate);
  }

  const flatEvals = allEvals.flat();

  const prevState = readRunState();
  const summary = summarizeJudgeRun(flatEvals.length, evalFailures, failureClasses, { usage, estimatedUsd, keySource: judgeKey.source }, prevState);
  (summary.exitCode === 0 ? console.log : console.error)(summary.line);
  // Every run that attempted something becomes the baseline, flagged or not:
  // keeping only clean runs let one flagged run hold the alarm on for good.
  if (summary.attempted > 0) writeRunState(summary.succeeded, summary.attempted);
  if (summary.exitCode !== 0) {
    // Set rather than exit: main's finally must still release the lock,
    // and populate-dashboard.ts reads this code to keep upload + sync running.
    process.exitCode = summary.exitCode;
  }
  return flatEvals;
}

/** Generate seed evaluations from trace data for sessions with no transcript. */
const BACKFILL_FLAG = '--backfill';
/** Flags judge-evaluations reads itself; --source=/--days=/--date= are read by derive's resolvers. */
const JUDGE_CLI: CliSpec = {
  values: [JUDGE_LIMIT_FLAG],
  switches: [DRY_RUN_FLAG, JUDGE_SEED_FLAG, BACKFILL_FLAG, JUDGE_BATCH_FLAG, JUDGE_PER_CRITERION_FLAG],
};

async function main() {
  const args = process.argv.slice(2);
  const { cli, requestedLimit } = exitOnCliArgError('Error:', () => {
    const parsed = parseCli(args, JUDGE_CLI);
    return { cli: parsed, requestedLimit: positiveIntArg(JUDGE_LIMIT_FLAG, parsed.value(JUDGE_LIMIT_FLAG)) };
  });
  const dryRun = cli.has(DRY_RUN_FLAG);
  const seed = cli.has(JUDGE_SEED_FLAG);
  const backfill = cli.has(BACKFILL_FLAG);
  const batch = cli.has(JUDGE_BATCH_FLAG);
  // Consolidated is the default (JCP4); --per-criterion opts out.
  const consolidated = !cli.has(JUDGE_PER_CRITERION_FLAG);
  const limit = requestedLimit === undefined ? Infinity : Math.min(requestedLimit, MAX_TURN_LIMIT);

  if (backfill) {
    await runBackfill();
    return;
  }

  const source = resolveSource(args, JUDGE_DEFAULT_SOURCE);
  const dateScope = readScope(source, resolveDateScope(args), JUDGE_DEFAULT_DAYS);
  let discovery: TurnDiscovery;
  try {
    discovery = await discoverTurns(source, dateScope);
  } catch (err) {
    // Nothing is spent before this point, so populate carries on without the judge.
    console.error(`[judge] discovery failed: ${describeUnknown(err)}`);
    process.exitCode = JUDGE_EXIT_DISCOVERY_FAILED;
    return;
  }
  const { turns, accounts, loadExistingKeys } = discovery;
  // --seed posts nothing, so only a real run skips turns it could not deliver.
  const select = (keys: Set<string>) => selectTurns(turns, keys, { limit, deliverableOnly: !seed });

  if (dryRun) {
    const selection = select(loadExistingKeys());
    console.log(`[dry-run] turns: ${formatTurnSelection(selection)}`);
    printDryRun(selection.selected, batch, consolidated);
    return;
  }

  // Validate API key early (before expensive operations). Seed mode needs no
  // key; the LLM branch below narrows on the same value.
  const judgeKey = seed ? undefined : resolveJudgeApiKey();
  if (!seed && !judgeKey) {
    console.error(`Error: ${JUDGE_API_KEY_ENV} or ${DEFAULT_API_KEY_ENV} required (or use --seed for offline mode)`);
    process.exit(1);
  }

  // Acquire lock to prevent concurrent writes
  acquireLockOrExit();

  try {
    const existingKeys = loadExistingKeys();
    const selection = select(existingKeys);
    console.log(`[judge] turns: ${formatTurnSelection(selection)}`);
    const allTurns = selection.selected;

    resetFailureTracking();

    // No key means --seed; the guard above exited otherwise.
    const flatEvals = judgeKey
      ? await judgeTurns(allTurns, existingKeys, judgeKey, { batch, consolidated })
      : seedEvaluations(allTurns, existingKeys).evals;

    if (flatEvals.length === 0) {
      return;
    }

    // The file stays the local ledger `_loadExistingKeys` reads. The records
    // also go straight to ingest, because `upload-evaluations` refuses anything
    // older than --max-age-hours and a judged turn is usually weeks old.
    const outFile = writeEvaluations(flatEvals);

    if (judgeKey) {
      const posted = await postEvaluationRecords(flatEvals.map(toOTelRecord), { dryRun: false, accounts });
      console.log(`[judge] posted ${formatPostSummary(posted)}`);
      if (posted.failure) {
        // Ingest drops any id it already holds, so re-sending the whole file is safe.
        console.error(`[judge] records are in ${outFile}; re-send them with upload-evaluations --days=1 and a --max-age-hours that reaches the oldest turn`);
        // Soft, so populate still runs upload + sync; this outranks a summary code.
        process.exitCode = JUDGE_EXIT_POST_FAILED;
      }
    }

  } finally {
    releaseLock();
  }
}

runIfMain(import.meta.url, main, '[judge]');
