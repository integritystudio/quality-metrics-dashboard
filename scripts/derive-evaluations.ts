#!/usr/bin/env tsx
/**
 * Derive rule-based evaluations from trace data and post them to ingest.
 *
 * Reads spans from obtool-api (`/v1/traces`, one query per `OBTOOL_API_KEY*`
 * account in the environment). Without `--date=`/`--days=`, it reads the
 * last `DERIVE_DEFAULT_DAYS`, as populate does. A failed cloud read exits `DERIVE_EXIT_READ_FAILED` (9) before anything is
 * posted.
 *
 * Every record is POSTed straight to ingest (`post-evaluations.ts`) with an
 * `evaluationId` the worker dedups on, so re-posting is a no-op. An unscoped
 * run posts the last two days; an explicit `--date=`/`--days=` posts the whole
 * scope, which is how a backfill is done, unless `--post-days=N` narrows the
 * post to the last N days (populate passes 2). Records dated before
 * `DERIVE_NO_REPOST_BEFORE_MS` are never posted. Nothing is written to disk
 * except `.calibration-state.json`.
 *
 *   tsx scripts/derive-evaluations.ts --dry-run                    # what populate runs: 7 days read, 2 posted
 *   tsx scripts/derive-evaluations.ts --date=2026-10-01 --dry-run
 *   tsx scripts/derive-evaluations.ts --days=3
 *   tsx scripts/derive-evaluations.ts --skip-derive-rules          # the agent heuristics only; see DERIVE_SKIP_RULES_FLAG
 */

import { ascending, rollup } from 'd3-array';
import pLimit from 'p-limit';
import { loadCalibrationState, saveCalibrationState } from '../../src/lib/quality/qfe-percentiles.js';
import type { LocalTraceSpan } from '../../src/lib/validation/dashboard-schemas.js';
export type { LocalTraceSpan as TraceSpan };
import {
  normalizeScore,
  SESSION_ID_PREVIEW_LEN,
  RULE_EVALUATOR_TYPE,
  toOTelRecord,
  type EvalRecord,
} from './eval-record.js';
import { CALIBRATION_STATE_DIR } from './evaluation-constants.js';
import { calibrationScores, decideCalibration } from './calibration-update.js';
import { detectInputDrift } from './derive-input-drift.js';
import { publishCalibration } from './publish-calibration.js';
import { HOOK_NAME, HOOK_SPAN_PREFIX } from '../src/api/api-constants.js';
import {
  attrString,
  byStartThenSpanId,
  deriveAll,
  DERIVE_NO_REPOST_BEFORE_MS,
  lastUtcDays,
  postFloorMs,
  recordsToPost,
  ruleRecord,
  setSpanAccounts,
} from './derive-rule-metrics.js';
import { emptyAccountIndex, formatPostSummary, postEvaluationRecords } from './post-evaluations.js';
import { loadCloudSpans, queryEachAccount, type LoadedSpans } from './cloud-trace-source.js';
import { CALIBRATION_WINDOW_DAYS } from '../../src/lib/quality/quality-constants.js';
import { DAYS_FLAG as DAYS_ARG, DERIVE_DEFAULT_DAYS, DERIVE_EXIT_INPUT_DRIFT, DERIVE_EXIT_POST_FAILED, DERIVE_EXIT_READ_FAILED, DERIVE_SKIP_RULES_FLAG, DRY_RUN_FLAG, POST_DAYS_FLAG as POST_DAYS_ARG, rejectRemovedFlags } from './pipeline-stages.js';
import { DURATION_MS, TIME_MS } from '../../src/lib/core/units.js';
import { hrtToSeconds, msToNs } from './hrt.js';
import { CliArgError, parseCli, positiveIntArg, type CliSpec } from './cli-args.js';
import { runIfMain } from './cli-main.js';
import { computeAgentHeuristicEvaluations } from '../../src/lib/agent-judge/agent-eval-metrics.js';
import { knownLabelSchema } from '../../src/lib/quality/qfe-label-ordinals.js';
import { readMultiTurnInput, readSingleTurnInput } from './agent-heuristic-inputs.js';
import { resolveTranscriptPath, scanTranscriptDirs } from './transcript-turns.js';
import { AGENT_ATTRIBUTES } from '../src/lib/hook-attributes.js';
import { SESSION_ATTRIBUTES } from '../../src/lib/otel/constants-otel.js';

/** Upper bound on stored rule rows read per account for calibration; 30 days hold ~45,000. */
const CALIBRATION_ROW_LIMIT = 500_000;

const CALIBRATION_LOG_PREFIX = '[derive] calibration:';

/** Transcripts parsed at once by `deriveAgentHeuristics`. */
const TRANSCRIPT_READ_CONCURRENCY = 8;

/**
 * Sessions whose last span started within this window are likely still in
 * progress. Scoring them now anchors on a transient last-span, so consecutive
 * derive runs produce different `evaluationId` hashes and D1 accumulates one
 * duplicate row per run (AGENT-HEURISTIC-INPROGRESS-DUPLICATES). Skip them;
 * the next scheduled run will score the completed session on a stable span.
 */
const MIN_SESSION_COMPLETION_AGE_MS = DURATION_MS.TWELVE_HOURS;

const SUBAGENT_STOP_SPAN = `${HOOK_SPAN_PREFIX}${HOOK_NAME.SUBAGENT_STOP}`;


/** The heuristics' scored results as rule records on `span`, keeping the label only some scorers assign. */
function heuristicRecords(
  span: LocalTraceSpan,
  sessionId: string,
  input: Parameters<typeof computeAgentHeuristicEvaluations>[0],
  fallbackExplanation: string,
): EvalRecord[] {
  return computeAgentHeuristicEvaluations(input).flatMap(ev => ev.scoreValue === undefined ? [] : [
    ruleRecord(span, sessionId, {
      evaluationName: ev.evaluationName,
      scoreValue: normalizeScore(ev.scoreValue),
      ...(ev.scoreUnit && { scoreUnit: ev.scoreUnit }),
      explanation: ev.explanation ?? fallbackExplanation,
      ...(ev.scoreLabel && { scoreLabel: knownLabelSchema.parse(ev.scoreLabel) }),
    }),
  ]);
}

type TranscriptLimit = ReturnType<typeof pLimit>;

/**
 * The run-level job this span opens — null unless it is a subagent stop whose
 * transcript resolves on this machine.
 */
function subagentJob(
  span: LocalTraceSpan,
  sessionId: string,
  attrs: LocalTraceSpan['attributes'],
  limit: TranscriptLimit,
): Promise<EvalRecord[]> | null {
  if (span.name !== SUBAGENT_STOP_SPAN) return null;
  const recordedPath = attrs[AGENT_ATTRIBUTES.TRANSCRIPT_PATH];
  const path = typeof recordedPath === 'string' ? resolveTranscriptPath(recordedPath) : null;
  if (!path) return null;
  const agentType = attrString(attrs[AGENT_ATTRIBUTES.TYPE], 'unknown');
  return limit(async () => {
    const input = await readSingleTurnInput(path);
    return input
      ? heuristicRecords(span, sessionId, input, `${agentType} agent: ${input.toolCalls.length} tool calls`)
      : [];
  });
}

/**
 * The session-level job this span closes. Sessions that may still be in progress
 * are skipped: their last-span changes on the next derive run, producing a
 * different evaluationId and a duplicate D1 row.
 */
function sessionJob(
  span: LocalTraceSpan,
  sessionId: string,
  sessionTranscripts: ReadonlyMap<string, string>,
  ctx: { limit: TranscriptLimit; nowMs: number },
): Promise<EvalRecord[]> | null {
  if (hrtToSeconds(span.startTime) * TIME_MS.SECOND > ctx.nowMs - MIN_SESSION_COMPLETION_AGE_MS) return null;
  const path = sessionTranscripts.get(sessionId);
  if (!path) return null;
  return ctx.limit(async () => {
    const input = await readMultiTurnInput(path);
    return input
      ? heuristicRecords(span, sessionId, input, `Session ${sessionId.slice(0, SESSION_ID_PREVIEW_LEN)}: ${input.turns.length} turns`)
        .map(r => ({ ...r, stableEvaluationKey: `session:${r.sessionId}:${r.evaluationName}` }))
      : [];
  });
}

/**
 * The agent heuristics only `agent-eval-metrics` computes:
 * `argument_correctness` and `agent_overall` per subagent run, from the transcript its
 * `subagent-stop` span names, and `conversation_completeness`, `turn_relevancy` and
 * `conversation_overall` per session, from `sessionTranscripts`, on the session's last span.
 *
 * Spans hold neither replies nor tool arguments, so a run or session whose transcript is
 * not on this machine is skipped rather than scored on placeholders. Spans that start
 * before `sinceMs` are not read, so a run opens only the transcripts it can post.
 */
export async function deriveAgentHeuristics(
  spans: readonly LocalTraceSpan[],
  sinceMs: number,
  sessionTranscripts: ReadonlyMap<string, string>,
  nowMs: number = Date.now(),
): Promise<EvalRecord[]> {
  const limit = pLimit(TRANSCRIPT_READ_CONCURRENCY);
  const jobs: Array<Promise<EvalRecord[]>> = [];
  const lastSpanBySession = new Map<string, LocalTraceSpan>();

  for (const span of spans) {
    if (hrtToSeconds(span.startTime) * TIME_MS.SECOND < sinceMs) continue;
    const attrs = span.attributes;
    const sessionId = attrString(attrs[SESSION_ATTRIBUTES.ID]);
    if (!sessionId) continue;
    const last = lastSpanBySession.get(sessionId);
    if (!last || byStartThenSpanId(last, span) < 0) lastSpanBySession.set(sessionId, span);

    const job = subagentJob(span, sessionId, attrs, limit);
    if (job) jobs.push(job);
  }

  for (const [sessionId, span] of lastSpanBySession) {
    const job = sessionJob(span, sessionId, sessionTranscripts, { limit, nowMs });
    if (job) jobs.push(job);
  }

  return (await Promise.all(jobs)).flat();
}

const ISO_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_ARG = '--date=';
/** Every flag derive reads; judge-evaluations reuses the readers below. */
const DERIVE_CLI: CliSpec = { values: [DATE_ARG, DAYS_ARG, POST_DAYS_ARG], switches: [DRY_RUN_FLAG, DERIVE_SKIP_RULES_FLAG] };

/**
 * The dates a run reads: the caller's `--date=`/`--days=`, else the last
 * `defaultDays`. The cloud read needs a bound because an unbounded read has no
 * memory ceiling.
 */
export function readScope(dateScope: Set<string> | null, defaultDays: number, now: Date = new Date()): Set<string> {
  return dateScope ?? lastUtcDays(defaultDays, now);
}

/**
 * The dates the caller asked for with `--date=` or `--days=`, or null when
 * neither was given. Null is not "all dates": see
 * `readScope`. It also leaves the post window to `DERIVE_POST_WINDOW_DAYS`.
 */
export function resolveDateScope(args: string[], now: Date = new Date()): Set<string> | null {
  const cli = parseCli(args, DERIVE_CLI);
  const date = cli.value(DATE_ARG);
  if (date !== undefined) {
    if (!ISO_DATE_ONLY_PATTERN.test(date)) {
      throw new CliArgError(`${DATE_ARG} must be YYYY-MM-DD, got "${date}"`);
    }
    return new Set([date]);
  }

  const days = positiveIntArg(DAYS_ARG, cli.value(DAYS_ARG));
  return days === undefined ? null : lastUtcDays(days, now);
}

/** `--post-days=N` as a day count; `null` when absent. */
export function resolvePostDays(args: string[]): number | null {
  return positiveIntArg(POST_DAYS_ARG, parseCli(args, DERIVE_CLI).value(POST_DAYS_ARG)) ?? null;
}

/**
 * The rule scores every account's org stored over the last
 * `CALIBRATION_WINDOW_DAYS`. Derive's own read is 7 days, in which most
 * metrics never reach `MIN_QUANTILE_SAMPLE_SIZE`; the stored rows are what
 * derive posted over the whole window, so nothing is re-scored.
 */
async function loadCalibrationScores(nowMs: number, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, number[]>> {
  const startDate = msToNs(nowMs - CALIBRATION_WINDOW_DAYS * TIME_MS.DAY);
  const perAccount = await queryEachAccount(
    env,
    { limit: CALIBRATION_ROW_LIMIT, rows: 'stored rule rows', truncates: 'the calibration window', logPrefix: CALIBRATION_LOG_PREFIX },
    async (backend) => backend.queryEvaluations({ source: 'table', evaluator: RULE_EVALUATOR_TYPE, startDate, limit: CALIBRATION_ROW_LIMIT }),
  );
  return calibrationScores(perAccount.flatMap(({ rows }) => rows));
}

/**
 * Compute per-metric percentile distributions over the calibration window and
 * persist them to `.calibration-state.json`, which `publishCalibration` puts
 * in KV as `meta:calibration`. Rewritten when a distribution drifts (PSI), a metric
 * first reaches the sample floor, or the state is past its maximum age; a dry
 * run says so instead. A failed read leaves the state as it was.
 */
async function updateCalibration(dryRun: boolean, nowMs: number = Date.now()): Promise<void> {
  let scoresByMetric: Record<string, number[]>;
  try {
    scoresByMetric = await loadCalibrationScores(nowMs);
  } catch (err) {
    console.error(`${CALIBRATION_LOG_PREFIX} read failed, state left unchanged:`, err);
    return;
  }

  const decision = decideCalibration(loadCalibrationState(CALIBRATION_STATE_DIR), scoresByMetric, nowMs);
  if (decision.kind === 'no-samples') {
    console.log(`${CALIBRATION_LOG_PREFIX} no metric has enough samples; state left unchanged`);
    return;
  }
  console.log(`${CALIBRATION_LOG_PREFIX} ${decision.check}`);
  if (decision.kind === 'unchanged') {
    console.log(`${CALIBRATION_LOG_PREFIX} unchanged, lastCalibrated=${decision.lastCalibrated}`);
    return;
  }
  if (dryRun) {
    console.log('[dry-run] would update .calibration-state.json');
    return;
  }
  if (decision.carried.length > 0) {
    console.log(`${CALIBRATION_LOG_PREFIX} kept the previous distribution for ${decision.carried.join(', ')} (too few samples this run)`);
  }
  saveCalibrationState(CALIBRATION_STATE_DIR, decision.state);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  rejectRemovedFlags(argv);
  const dateScope = resolveDateScope(argv);
  const scope = readScope(dateScope, DERIVE_DEFAULT_DAYS);
  const postDays = resolvePostDays(argv);
  const cli = parseCli(argv, DERIVE_CLI);
  const dryRun = cli.has(DRY_RUN_FLAG);
  const skipRules = cli.has(DERIVE_SKIP_RULES_FLAG);

  let loaded: LoadedSpans;
  try {
    loaded = await loadCloudSpans(scope);
  } catch (err) {
    // Nothing is derived or posted yet, so populate carries on
    // without derive. The whole error, cause included, goes to stderr so
    // populate can tell a network failure (retried) from anything else.
    console.error('[derive] cloud read failed:', err);
    process.exitCode = DERIVE_EXIT_READ_FAILED;
    return;
  }
  // The heuristics stamp each record from the same span accounts the rule scorers set.
  setSpanAccounts(loaded.accounts);
  const allEvals = skipRules ? [] : deriveAll(loaded);
  // The window comes from the caller's scope, not the defaulted read, so an
  // unscoped run posts the last DERIVE_POST_WINDOW_DAYS of its 7-day read.
  const floorMs = postFloorMs(dateScope, Date.now(), postDays);
  allEvals.push(...await deriveAgentHeuristics(
    loaded.spans,
    Math.max(floorMs, DERIVE_NO_REPOST_BEFORE_MS),
    new Map(scanTranscriptDirs().map(t => [t.sessionId, t.path])),
  ));

  // Every cloud span is stamped with the org that shipped it, so no record
  // needs the local account join.
  const accounts = emptyAccountIndex();
  const { inScope, toPost, heldBack } = recordsToPost(allEvals, scope, floorMs);
  if (heldBack.length > 0) {
    console.log(`[derive] held back ${heldBack.length} records dated before ${new Date(DERIVE_NO_REPOST_BEFORE_MS).toISOString()}: D1 holds copies under ids this run cannot reproduce, so a re-post would duplicate them`);
  }
  const posted = await postEvaluationRecords(toPost.map(ev => toOTelRecord(ev)), { dryRun, accounts });
  console.log(`[derive]${dryRun ? ' dry-run:' : ''} posted ${formatPostSummary(posted)}`);
  if (posted.failure) {
    // stderr, so populate can tell a network failure (retried) from a rejection.
    console.error(`[derive] post failed: ${posted.failure}`);
    process.exitCode = DERIVE_EXIT_POST_FAILED;
  }

  if (!skipRules) {
    await updateCalibration(dryRun);
    await publishCalibration(dryRun);
  }

  const byName = rollup(inScope, evs => evs.length, ev => ev.evaluationName);
  const counts = [...byName].toSorted(([a], [b]) => ascending(a, b)).map(([name, n]) => `${name}=${n}`);
  console.log(`[derive] records: ${counts.join(' ') || 'none'}`);

  const drift = skipRules ? [] : detectInputDrift(loaded.spans, scope);
  for (const warning of drift) console.error(`[derive] input drift on ${warning}`);
  // A failed post is the more urgent code; drift persists and shows on the next run.
  if (drift.length > 0 && process.exitCode === undefined) process.exitCode = DERIVE_EXIT_INPUT_DRIFT;
}

runIfMain(import.meta.url, main, '[derive]');
