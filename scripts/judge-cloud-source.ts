/**
 * Cloud discovery for `judge-evaluations --source=cloud` (cloud-read migration
 * Phase 4). Which sessions to judge, which account each turn ran under, and
 * which turns are already scored all come from obtool-api; only the turn text
 * still comes from the transcripts on this machine (Phase 5 keeps it there).
 *
 * - **Sessions and anchoring**: `/v1/traces` over the scope, one query per
 *   account key (`loadCloudSpans`, derive's cloud reader). Every span is
 *   stamped with the account whose key read it, and the spans are indexed
 *   exactly as local trace files are, so `anchorTurns` runs unchanged. The
 *   session list is the set of sessions those spans name; `/v1/sessions` is
 *   built from the same spans, so a second read would add nothing.
 * - **Transcripts**: found by session id under `TRANSCRIPT_DIRS`, never through
 *   the local token-metrics logs, so no telemetry file is read.
 * - **Already judged**: `/v1/evaluations` rows from the judge's two producers,
 *   one query per account and producer, keyed like `_loadExistingKeys`. This
 *   is the cloud's record of what reached the dashboard, so a turn judged
 *   locally but never delivered is judged again, and this time posted.
 */

import type { EvaluationResult } from '../../src/backends/index.js';
import { NANOSECONDS_PER_MILLISECOND_BIGINT } from '../../src/lib/core/units.js';
import { IDENTITY_KEY_REF_FIELD, indexSpanRecords, type AccountIndex } from './account-stamps.js';
import { dateScopeBounds, loadCloudSpans, msToNs, queryEachAccount, type LoadedSpans } from './cloud-trace-source.js';
import { CONSOLIDATED_PRODUCER } from './judge-consolidated.js';
import { PRODUCER } from './eval-record.js';
import { turnKeyOf, addJudgedKeys } from './judge-dedup.js';
import { TRANSCRIPT_DIRS, scanTranscriptDirs, type TranscriptInfo } from './judge-turns.js';

/** Every producer the judge has written under: per-criterion and consolidated. */
const JUDGE_PRODUCERS = [PRODUCER, CONSOLIDATED_PRODUCER] as const;

/** Upper bound on evaluation rows held per account and producer; a run writes ~500. */
const CLOUD_EVALUATION_LIMIT = 200_000;

const DATE_ONLY_LEN = 'YYYY-MM-DD'.length;
const CLI_PREFIX = '[judge:cloud]';
/** Pre-EVAL-WEBHOOK-EVENT-TIME rows kept the client's event time here; their timestamp is receipt time. */
const LEGACY_EVENT_TIME_ATTR = 'evaluatedAtMs';

export interface CloudJudgeDiscovery {
  transcripts: TranscriptInfo[];
  /** Built from the cloud spans; anchors turns and routes their posts. */
  accounts: AccountIndex;
  /** Both dedup keys (`addJudgedKeys`) for every turn the cloud holds a judge row for. */
  existingKeys: Set<string>;
  /** Sessions the cloud names that have no transcript here: judged only where they ran. */
  sessionsWithoutTranscript: number;
}

/**
 * The span dates to read for turns on `dates`: those dates plus the day after
 * the last, when it has started. A turn's spans follow it, so a turn late on
 * the last day can be anchored only by spans past midnight.
 */
export function spanScopeDates(dates: ReadonlySet<string>, nowMs: number): Set<string> {
  const { toMs } = dateScopeBounds(dates);
  const nextDayMs = toMs + 1;
  const spanDates = new Set(dates);
  if (nextDayMs <= nowMs) spanDates.add(new Date(nextDayMs).toISOString().slice(0, DATE_ONLY_LEN));
  return spanDates;
}

/** Index cloud spans as local trace files are indexed, each stamped with the account that read it. */
export function indexCloudSpans(loaded: LoadedSpans): AccountIndex {
  return indexSpanRecords(loaded.spans.map((span) => {
    const ref = loaded.accounts.get(span.spanId);
    return ref === undefined ? span : { ...span, [IDENTITY_KEY_REF_FIELD]: ref };
  }));
}

/** When the scored turn happened: the row's event time, or the legacy attribute on a receipt-time row. */
function evaluationEventMs(row: EvaluationResult): number {
  const legacy = row.attributes?.[LEGACY_EVENT_TIME_ATTR];
  return typeof legacy === 'number' ? legacy : Number(row.timestamp / NANOSECONDS_PER_MILLISECOND_BIGINT);
}

/** Dedup keys in `_loadExistingKeys`' shape, plain and per judge model; a row without a session scores no transcript turn. */
export function judgedKeys(rows: Iterable<EvaluationResult>): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row.sessionId) continue;
    const turnKey = turnKeyOf(evaluationEventMs(row));
    addJudgedKeys(keys, { sessionId: row.sessionId, evaluationName: row.evaluationName, turnKey, judgeModel: row.judgeModel, cohort: row.cohort });
  }
  return keys;
}

/** The transcripts of `sessionIds` found under `dirs`, and how many sessions had none. */
export function transcriptsForSessions(
  sessionIds: Iterable<string>,
  dirs: readonly string[] = TRANSCRIPT_DIRS,
): { transcripts: TranscriptInfo[]; missing: number } {
  const byId = new Map(scanTranscriptDirs(dirs).map((t) => [t.sessionId, t]));
  const transcripts: TranscriptInfo[] = [];
  let missing = 0;
  for (const id of sessionIds) {
    const transcript = byId.get(id);
    if (transcript) transcripts.push(transcript);
    else missing++;
  }
  return { transcripts, missing };
}

/** Judge rows from every account in `env` whose event time can fall on or after `fromMs`. */
async function loadJudgedRows(fromMs: number, env: NodeJS.ProcessEnv): Promise<EvaluationResult[]> {
  const rows: EvaluationResult[] = [];
  for (const evaluator of JUDGE_PRODUCERS) {
    const perAccount = await queryEachAccount(
      env,
      CLOUD_EVALUATION_LIMIT,
      { rows: `${evaluator} rows`, truncates: 'the dedup set' },
      CLI_PREFIX,
      // No end bound: a receipt-time row is dated after its turn, never before.
      (backend) => backend.queryEvaluations({ source: 'table', evaluator, startDate: msToNs(fromMs), limit: CLOUD_EVALUATION_LIMIT }),
    );
    for (const { rows: found } of perAccount) rows.push(...found);
  }
  return rows;
}

/** Discover the sessions, accounts and judged turns for turns on `dates`. */
export async function discoverFromCloud(
  dates: ReadonlySet<string>,
  env: NodeJS.ProcessEnv = process.env,
  nowMs: number = Date.now(),
): Promise<CloudJudgeDiscovery> {
  const loaded = await loadCloudSpans(spanScopeDates(dates, nowMs), env, CLI_PREFIX);
  const accounts = indexCloudSpans(loaded);
  const { transcripts, missing } = transcriptsForSessions(accounts.sessionSpans.keys());
  const existingKeys = judgedKeys(await loadJudgedRows(dateScopeBounds(dates).fromMs, env));
  console.log(`${CLI_PREFIX} sessions=${accounts.sessionSpans.size} withTranscript=${transcripts.length} withoutTranscript=${missing} judgedKeys=${existingKeys.size}`);
  return { transcripts, accounts, existingKeys, sessionsWithoutTranscript: missing };
}
