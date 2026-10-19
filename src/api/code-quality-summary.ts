/**
 * Code-quality aggregation shared by the dev API route (`routes/code-quality.ts`,
 * live query) and `scripts/sync-to-kv.ts` (production: the Worker serves the
 * `code-quality` KV key it writes). One implementation, so the two paths cannot
 * disagree on grouping, defaults or number parsing.
 */

import { mean } from 'd3-array';
import { CONTENT_KIND, SURVIVAL_COHORT, type ContentKind, type SurvivalCohort } from '../lib/constants.js';
import { GENAI_AGENT_ATTRIBUTES } from '../lib/otel-attributes.js';
import { attrStr, timestampToMs, type SpanLike } from './api-constants.js';
import { CODE_ATTRIBUTES } from '../lib/hook-attributes.js';

export const CODE_QUALITY_LOOKBACK_DAYS = 90;
/**
 * queryTraces validates `limit <= 1000` (a 5000 here made the route 500 on
 * every request). At three checkpoints per seed, 1000 covers ~330 seeds in
 * the lookback — past that the oldest are dropped.
 */
export const CODE_QUALITY_CHECKPOINT_LIMIT = 1000;
export const CODE_QUALITY_INVOCATION_LIMIT = 1000;
/** KV key the sync writes and the Worker's `/api/code-quality` reads (org-prefixed by both). */
export const CODE_QUALITY_KV_KEY = 'code-quality';

/** `integritystudio.code.event` values — string, so the cloud filters them server-side. */
export const CODE_EVENT = { CHECKPOINT: 'survival_checkpoint', GENERATED: 'generated' } as const;

const KEY_SEP = '\x00';

const ATTR = {
  AGENT_NAME: GENAI_AGENT_ATTRIBUTES.AGENT_NAME,
  AGENT_VERSION: GENAI_AGENT_ATTRIBUTES.AGENT_VERSION,
} as const;

/**
 * The cloud API returns every attribute value as a string ("0.92"), where the
 * local hook JSONL keeps numbers. `attrNum` returns its fallback for a string,
 * so read through both forms — otherwise every cloud-fed rate reads 0.
 */
function attrRate(span: SpanLike, key: string): number {
  const raw = span.attributes?.[key];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function cohortOf(span: SpanLike): SurvivalCohort {
  return attrStr(span, CODE_ATTRIBUTES.SURVIVAL_COHORT) === SURVIVAL_COHORT.BASELINE ? SURVIVAL_COHORT.BASELINE : SURVIVAL_COHORT.SCORED;
}

function contentKindOf(span: SpanLike): ContentKind {
  return attrStr(span, CODE_ATTRIBUTES.CONTENT_KIND) === CONTENT_KIND.DOC ? CONTENT_KIND.DOC : CONTENT_KIND.CODE;
}

export type { ContentKind, SurvivalCohort };

export type AgentWindowStats = {
  agentName: string;
  agentVersion: string;
  window: string;
  cohort: SurvivalCohort;
  contentKind: ContentKind;
  avgSurvivalRate: number;
  avgChurnRate: number;
  avgDeletionRate: number;
  checkpointCount: number;
  latestTimestamp: string;
}

export type AgentVersionStats = {
  agentName: string;
  agentVersion: string;
  cohort: SurvivalCohort;
  invocationCount: number;
  latestTimestamp: string;
}

export type CodeQualityResponse = {
  survivalByAgentWindow: AgentWindowStats[];
  versionRollout: AgentVersionStats[];
  hasData: boolean;
}

type WindowAcc = {
  cohort: SurvivalCohort;
  contentKind: ContentKind;
  survivalRates: number[];
  churnRates: number[];
  deletionRates: number[];
  latestMs: number;
};

type VersionAcc = {
  cohort: SurvivalCohort;
  invocationCount: number;
  latestMs: number;
};

type CodeQualitySpan = SpanLike & { startTimeUnixNano?: string | number | bigint | null | undefined };

/** The later of the accumulated timestamp and this span's, ignoring an unparseable one. */
function laterMs(current: number, span: CodeQualitySpan): number {
  const spanMs = timestampToMs(span.startTimeUnixNano);
  return Number.isFinite(spanMs) && spanMs > current ? spanMs : current;
}

/** An accumulator that never saw a parseable timestamp reports none. */
function isoOrEmpty(latestMs: number): string {
  return latestMs > 0 ? new Date(latestMs).toISOString() : '';
}

function startMs(span: CodeQualitySpan): number {
  const ms = timestampToMs(span.startTimeUnixNano);
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * One span per checkpoint: re-measuring a seed writes a second span for the same
 * window, and the later one supersedes it. The cloud returns spans in no fixed
 * order, so "later" is the start time. A span without a seed commit is kept as is.
 */
export function latestCheckpointSpans(checkpointSpans: readonly CodeQualitySpan[]): CodeQualitySpan[] {
  const latest = new Map<string, CodeQualitySpan>();
  const unkeyed: CodeQualitySpan[] = [];
  for (const span of checkpointSpans) {
    const commit = attrStr(span, CODE_ATTRIBUTES.SEED_CHANGE_ID);
    if (commit === 'unknown') {
      unkeyed.push(span);
      continue;
    }
    const key = [commit, attrStr(span, ATTR.AGENT_NAME), attrStr(span, CODE_ATTRIBUTES.CHECKPOINT_WINDOW), contentKindOf(span)].join(KEY_SEP);
    const kept = latest.get(key);
    if (!kept || startMs(span) >= startMs(kept)) latest.set(key, span);
  }
  return [...latest.values(), ...unkeyed];
}

/** Checkpoint rates grouped by (agentName, agentVersion, window, cohort, contentKind). */
function accumulateWindows(checkpointSpans: readonly CodeQualitySpan[]): Map<string, WindowAcc> {
  const windowAcc = new Map<string, WindowAcc>();

  for (const span of checkpointSpans) {
    const agentName = attrStr(span, ATTR.AGENT_NAME);
    const agentVersion = attrStr(span, ATTR.AGENT_VERSION);
    const checkpointWindow = attrStr(span, CODE_ATTRIBUTES.CHECKPOINT_WINDOW);

    if (agentName === 'unknown' || checkpointWindow === 'unknown') continue;

    const cohort = cohortOf(span);
    const contentKind = contentKindOf(span);
    const key = [agentName, agentVersion, checkpointWindow, cohort, contentKind].join(KEY_SEP);
    let entry = windowAcc.get(key);
    if (!entry) {
      entry = { cohort, contentKind, survivalRates: [], churnRates: [], deletionRates: [], latestMs: 0 };
      windowAcc.set(key, entry);
    }

    entry.survivalRates.push(attrRate(span, CODE_ATTRIBUTES.SURVIVAL_RATE));
    entry.churnRates.push(attrRate(span, CODE_ATTRIBUTES.CHURN_RATE));
    entry.deletionRates.push(attrRate(span, CODE_ATTRIBUTES.DELETION_RATE));
    entry.latestMs = laterMs(entry.latestMs, span);
  }

  return windowAcc;
}

function toAgentWindowStats(windowAcc: Map<string, WindowAcc>): AgentWindowStats[] {
  const survivalByAgentWindow: AgentWindowStats[] = [];
  for (const [key, entry] of windowAcc) {
    const [agentName = 'unknown', agentVersion = 'unknown', window = 'unknown'] = key.split(KEY_SEP);
    survivalByAgentWindow.push({
      agentName,
      agentVersion,
      window,
      cohort: entry.cohort,
      contentKind: entry.contentKind,
      avgSurvivalRate: mean(entry.survivalRates) ?? 0,
      avgChurnRate: mean(entry.churnRates) ?? 0,
      avgDeletionRate: mean(entry.deletionRates) ?? 0,
      checkpointCount: entry.survivalRates.length,
      latestTimestamp: isoOrEmpty(entry.latestMs),
    });
  }
  return survivalByAgentWindow;
}

/** Invocation counts grouped by (agentName, agentVersion, cohort). */
function accumulateVersions(invocationSpans: readonly CodeQualitySpan[]): Map<string, VersionAcc> {
  const versionAcc = new Map<string, VersionAcc>();

  for (const span of invocationSpans) {
    const agentName = attrStr(span, ATTR.AGENT_NAME);
    const agentVersion = attrStr(span, ATTR.AGENT_VERSION);
    const cohort = cohortOf(span);
    const key = [agentName, agentVersion, cohort].join(KEY_SEP);

    let entry = versionAcc.get(key);
    if (!entry) {
      entry = { cohort, invocationCount: 0, latestMs: 0 };
      versionAcc.set(key, entry);
    }

    entry.invocationCount++;
    entry.latestMs = laterMs(entry.latestMs, span);
  }

  return versionAcc;
}

function toVersionStats(versionAcc: Map<string, VersionAcc>): AgentVersionStats[] {
  const versionRollout: AgentVersionStats[] = [];
  for (const [key, entry] of versionAcc) {
    const [agentName = 'unknown', agentVersion = 'unknown'] = key.split(KEY_SEP);
    versionRollout.push({
      agentName,
      agentVersion,
      cohort: entry.cohort,
      invocationCount: entry.invocationCount,
      latestTimestamp: isoOrEmpty(entry.latestMs),
    });
  }
  return versionRollout;
}

export function summarizeCodeQuality(
  checkpointSpans: readonly CodeQualitySpan[],
  invocationSpans: readonly CodeQualitySpan[],
): CodeQualityResponse {
  const survivalByAgentWindow = toAgentWindowStats(accumulateWindows(latestCheckpointSpans(checkpointSpans)));
  const versionRollout = toVersionStats(accumulateVersions(invocationSpans))
    .toSorted((a, b) => b.invocationCount - a.invocationCount);

  return {
    survivalByAgentWindow,
    versionRollout,
    hasData: survivalByAgentWindow.length > 0,
  };
}
