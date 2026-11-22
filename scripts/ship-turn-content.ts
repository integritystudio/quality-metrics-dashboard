#!/usr/bin/env tsx
/**
 * Ship redacted judge turns to the cloud (Phase 5 option B,
 * docs/archive/judge-turn-content-cloud.md in the parent repo).
 *
 * Runs where the transcripts are, between derive and the judge in `populate`:
 *   1. discover the sessions the cloud's spans name over the judge's scope,
 *      extract their turns from the transcripts here and anchor each to its
 *      account and span, exactly as the judge does;
 *   2. skip turns the cloud already holds (`GET /v1/turns`, per account);
 *   3. redact every text field with the R10 rules, withhold any turn whose
 *      redaction is incomplete, and POST the rest, per account, to
 *      `POST /v1/turns` on ingest.
 *
 * Only the turn's account key posts it, so a turn lands in its own org. A turn
 * with no account (unmapped or unanchored) is never sent. Re-sending is safe:
 * ingest keeps the first copy of each turn key.
 *
 * Usage: tsx ship-turn-content.ts [--days=N | --date=YYYY-MM-DD] [--dry-run]
 * Needs OBTOOL_INGEST_URL, OBTOOL_API_URL and the OBTOOL_API_KEY* account keys.
 */

import pLimit from 'p-limit';
import {
  TURNS_PATH,
  TURN_CONTENT_MAX_BATCH_SIZE,
  TURN_CONTENT_MAX_FIELD_LENGTH,
  TURN_CONTENT_OPTED_OUT_CODE,
} from '../../src/lib/core/obtool-contract.js';
import { redactText, REDACTION_RULESET_VERSION, REDACTION_TRUNCATION_SENTINEL } from '../../src/lib/privacy/content-redaction.js';
import { unredactedCategories } from '../../src/lib/privacy/redaction-patterns.js';
import { turnContentKey, type TurnContentRecord } from '../../src/lib/validation/api-schemas.js';
import { describeUnknown } from '../../src/lib/core/describe-unknown.js';
import { toDateOnly } from '../src/api/api-constants.js';
import { CONTENT_TYPE_HEADER, ContentType } from '../src/lib/http-constants.js';
import { asString } from './account-index.js';
import { dateScopeBounds, queryEachAccount } from './cloud-trace-source.js';
import { readScope, resolveDateScope } from './derive-evaluations.js';
import { formatCounts, INGEST_URL_ENV, INGEST_URL_NOT_SET_MESSAGE, INTER_BATCH_DELAY_MS, postBatch } from './evaluation-delivery.js';
import { discoverCloudSessions } from './judge-cloud-source.js';
import { anchorTurns, extractTurns, fitContextForJudge, turnKey, type Turn } from './judge-turns.js';
import { msToNs } from './hrt.js';
import { DRY_RUN_FLAG, JUDGE_DEFAULT_DAYS, SHIP_TURNS_EXIT_DISCOVERY_FAILED, SHIP_TURNS_EXIT_POST_FAILED, rejectRemovedFlags } from './pipeline-stages.js';
import { exitOnCliArgError, parseCli, runIfMain } from './cli-args.js';
import { increment } from './collections.js';
import { sleep } from './sleep.js';

const CLI_PREFIX = '[ship-turns]';
/** Upper bound on turn rows read back per account; a week holds ~2,000. */
const CLOUD_TURN_LIMIT = 50_000;
/** Transcripts read at once. */
const EXTRACT_CONCURRENCY = 8;

/** Why a turn is not sent. */
export type WithholdReason =
  | 'no-account'
  | 'unmapped-account'
  | 'incomplete-redaction'
  | 'unredacted'
  | 'too-large';

export type RecordResult = { record: TurnContentRecord } | { withheld: WithholdReason };

/**
 * The record shipped for `turn`: every text field through `redactText`, the
 * tool context fitted as the judge fits it first. Withheld when redaction
 * reports truncation (the sentinel), when a field still matches a rule (a
 * redactor fault ingest would refuse anyway), or when a field outgrows the cap.
 */
export function toTurnContentRecord(turn: Turn): RecordResult {
  const original = [turn.userText, turn.assistantText, ...fitContextForJudge(turn.toolResults)];
  const redacted = original.map((text) => redactText(text));
  if (redacted.some((text) => text.includes(REDACTION_TRUNCATION_SENTINEL))) return { withheld: 'incomplete-redaction' };
  if (redacted.some((text) => unredactedCategories(text).length > 0)) return { withheld: 'unredacted' };
  if (redacted.some((text) => text.length > TURN_CONTENT_MAX_FIELD_LENGTH)) return { withheld: 'too-large' };
  const [userText = '', assistantText = '', ...toolContext] = redacted;
  return {
    record: {
      turnKey: turnContentKey(turn.sessionId, turn.timestamp),
      sessionId: turn.sessionId,
      timestamp: turn.timestamp,
      ...(turn.traceId && { traceId: turn.traceId }),
      ...(turn.spanId && { spanId: turn.spanId }),
      ...(turn.responseId && { responseId: turn.responseId }),
      userText,
      assistantText,
      toolContext,
      redaction: { version: REDACTION_RULESET_VERSION, changed: redacted.some((text, i) => text !== original[i]) },
    },
  };
}

export type ShipmentPlan = {
  /** Records to POST, by account env var. */
  byAccount: Map<string, TurnContentRecord[]>;
  discovered: number;
  inCloud: number;
  withheld: Record<string, number>;
  /** Turns whose account key is not in this environment, by account. */
  heldForKey: Record<string, number>;
};

/**
 * Sort turns into what to send and why the rest stay. A turn whose key the
 * cloud already holds for its account is skipped before it is redacted.
 */
export function planShipment(
  turns: readonly Turn[],
  inCloud: ReadonlyMap<string, ReadonlySet<string>>,
  env: NodeJS.ProcessEnv,
): ShipmentPlan {
  const plan: ShipmentPlan = { byAccount: new Map(), discovered: turns.length, inCloud: 0, withheld: {}, heldForKey: {} };
  for (const turn of turns) {
    const ref = turn.identityKeyRef;
    if (ref === undefined) { increment(plan.withheld, 'no-account'); continue; }
    if (ref === null) { increment(plan.withheld, 'unmapped-account'); continue; }
    if (inCloud.get(ref)?.has(turnKey(turn))) { plan.inCloud++; continue; }
    if (!asString(env[ref])) { increment(plan.heldForKey, ref); continue; }
    const result = toTurnContentRecord(turn);
    if ('withheld' in result) { increment(plan.withheld, result.withheld); continue; }
    const records = plan.byAccount.get(ref) ?? [];
    records.push(result.record);
    plan.byAccount.set(ref, records);
  }
  return plan;
}

export type SendSummary = {
  sent: number;
  /** Accounts whose org refused content shipping (403 opt-out); their turns are not retried. */
  optedOut: string[];
  failure?: string;
};

/** POST each account's records in batches, with that account's key. Stops at the first failed batch. */
export async function sendPlan(plan: ShipmentPlan, baseUrl: string, env: NodeJS.ProcessEnv): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, optedOut: [] };
  for (const [ref, records] of plan.byAccount) {
    const apiKey = asString(env[ref]);
    if (apiKey === undefined) continue;
    for (let i = 0; i < records.length; i += TURN_CONTENT_MAX_BATCH_SIZE) {
      const chunk = records.slice(i, i + TURN_CONTENT_MAX_BATCH_SIZE);
      // eslint-disable-next-line no-await-in-loop -- batches are paced and stop at the first failure
      const result = await postBatch({
        url: `${baseUrl}${TURNS_PATH}`,
        headers: { [CONTENT_TYPE_HEADER]: ContentType.Ndjson, Authorization: `Bearer ${apiKey}` },
        body: `${chunk.map((record) => JSON.stringify(record)).join('\n')}\n`,
      });
      if (!result.ok && result.detail.includes(TURN_CONTENT_OPTED_OUT_CODE)) {
        summary.optedOut.push(ref);
        break;
      }
      if (!result.ok) {
        summary.failure = `POST ${TURNS_PATH} for ${ref} failed: ${result.detail}`;
        return summary;
      }
      summary.sent += chunk.length;
      // eslint-disable-next-line no-await-in-loop -- the pacing delay between batches is the point
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }
  return summary;
}

/** The turn keys each account's org already holds for `dates`. */
async function loadCloudTurnKeys(dates: ReadonlySet<string>, env: NodeJS.ProcessEnv): Promise<Map<string, Set<string>>> {
  const { fromMs, toMs } = dateScopeBounds(dates);
  const perAccount = await queryEachAccount(
    env,
    { limit: CLOUD_TURN_LIMIT, rows: 'shipped turns', truncates: 'the already-shipped set', logPrefix: CLI_PREFIX },
    async (backend) => backend.queryTurns({ startDate: msToNs(fromMs), endDate: msToNs(toMs), limit: CLOUD_TURN_LIMIT }),
  );
  return new Map(perAccount.map(({ ref, rows }) => [ref, new Set(rows.map((row) => row.turnKey))]));
}

/** The anchored turns on `dates` from the transcripts on this machine, as the judge finds them. */
async function discoverLocalTurns(dates: ReadonlySet<string>, env: NodeJS.ProcessEnv): Promise<Turn[]> {
  const { accounts, transcripts, missing } = await discoverCloudSessions(dates, env);
  console.log(`${CLI_PREFIX} sessions=${accounts.sessionSpans.size} withTranscript=${transcripts.length} withoutTranscript=${missing}`);
  const turns = (await pLimit(EXTRACT_CONCURRENCY).map(transcripts, async (info) => extractTurns(info))).flat();
  anchorTurns(turns, accounts);
  return turns.filter((turn) => dates.has(toDateOnly(turn.timestamp)));
}

function formatPlan(plan: ShipmentPlan): string {
  const toSend = [...plan.byAccount].map(([ref, records]) => `${ref}=${records.length}`).join(' ') || 'none';
  const held = Object.keys(plan.heldForKey).length > 0 ? ` heldForKey[${formatCounts(plan.heldForKey)}]` : '';
  return `discovered=${plan.discovered} inCloud=${plan.inCloud} toSend[${toSend}] withheld[${formatCounts(plan.withheld)}]${held}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = exitOnCliArgError(`${CLI_PREFIX} Error:`, () => {
    rejectRemovedFlags(args);
    return parseCli(args, { switches: [DRY_RUN_FLAG] }).has(DRY_RUN_FLAG);
  });
  const dates = readScope(resolveDateScope(args), JUDGE_DEFAULT_DAYS);
  const env = process.env;

  let plan: ShipmentPlan;
  try {
    const turns = await discoverLocalTurns(dates, env);
    plan = planShipment(turns, await loadCloudTurnKeys(dates, env), env);
  } catch (err) {
    // Nothing was sent; the next run covers the same window.
    console.error(`${CLI_PREFIX} discovery failed: ${describeUnknown(err)}`);
    process.exitCode = SHIP_TURNS_EXIT_DISCOVERY_FAILED;
    return;
  }
  console.log(`${CLI_PREFIX} ${formatPlan(plan)}`);
  if (dryRun) return;

  const baseUrl = asString(env[INGEST_URL_ENV]);
  if (baseUrl === undefined) {
    console.error(`${CLI_PREFIX} ${INGEST_URL_NOT_SET_MESSAGE}`);
    process.exitCode = SHIP_TURNS_EXIT_POST_FAILED;
    return;
  }
  const summary = await sendPlan(plan, baseUrl, env);
  const optedOut = summary.optedOut.length > 0 ? ` optedOut[${summary.optedOut.join(' ')}]` : '';
  console.log(`${CLI_PREFIX} sent=${summary.sent}${optedOut}`);
  if (summary.failure !== undefined) {
    console.error(`${CLI_PREFIX} ${summary.failure}`);
    process.exitCode = SHIP_TURNS_EXIT_POST_FAILED;
  }
}

runIfMain(import.meta.url, main, CLI_PREFIX);
