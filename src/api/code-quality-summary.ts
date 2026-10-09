/**
 * Code-quality aggregation shared by the dev API route (`routes/code-quality.ts`,
 * live query) and `scripts/sync-to-kv.ts` (production: the Worker serves the
 * `code-quality` KV key it writes). One implementation, so the two paths cannot
 * disagree on grouping, defaults or number parsing.
 */

import { CONTENT_KIND, SURVIVAL_COHORT, type ContentKind, type SurvivalCohort } from '../lib/constants.js';
import { GENAI_AGENT_ATTRIBUTES } from '../lib/otel-attributes.js';
import { attrStr, timestampToMs, type SpanLike } from './api-constants.js';

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
export const CODE_EVENT_ATTR = 'integritystudio.code.event';

const KEY_SEP = '\x00';

const ATTR = {
  AGENT_NAME: GENAI_AGENT_ATTRIBUTES.AGENT_NAME,
  AGENT_VERSION: GENAI_AGENT_ATTRIBUTES.AGENT_VERSION,
  WINDOW: 'integritystudio.code.checkpoint_window',
  COHORT: 'integritystudio.code.survival.cohort',
  CONTENT_KIND: 'integritystudio.code.content_kind',
  CODE_EVENT: 'integritystudio.code.event',
  SURVIVAL_RATE: 'integritystudio.code.quality.survival_rate',
  CHURN_RATE: 'integritystudio.code.quality.churn_rate',
  DELETION_RATE: 'integritystudio.code.quality.deletion_rate',
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
  return attrStr(span, ATTR.COHORT) === SURVIVAL_COHORT.BASELINE ? SURVIVAL_COHORT.BASELINE : SURVIVAL_COHORT.SCORED;
}

function contentKindOf(span: SpanLike): ContentKind {
  return attrStr(span, ATTR.CONTENT_KIND) === CONTENT_KIND.DOC ? CONTENT_KIND.DOC : CONTENT_KIND.CODE;
}

export type { ContentKind, SurvivalCohort };

export interface AgentWindowStats {
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

export interface AgentVersionStats {
  agentName: string;
  agentVersion: string;
  cohort: SurvivalCohort;
  invocationCount: number;
  latestTimestamp: string;
}

export interface CodeQualityResponse {
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

type CodeQualitySpan = SpanLike & { startTimeUnixNano?: string | number | bigint | null };

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

export function summarizeCodeQuality(
  checkpointSpans: readonly CodeQualitySpan[],
  invocationSpans: readonly CodeQualitySpan[],
): CodeQualityResponse {
  // Aggregate checkpoint spans by (agentName, agentVersion, window, cohort, contentKind)
  const windowAcc = new Map<string, WindowAcc>();

  for (const span of checkpointSpans) {
    const agentName = attrStr(span, ATTR.AGENT_NAME);
    const agentVersion = attrStr(span, ATTR.AGENT_VERSION);
    const checkpointWindow = attrStr(span, ATTR.WINDOW);

    if (agentName === 'unknown' || checkpointWindow === 'unknown') continue;

    const cohort = cohortOf(span);
    const contentKind = contentKindOf(span);
    const key = [agentName, agentVersion, checkpointWindow, cohort, contentKind].join(KEY_SEP);
    let entry = windowAcc.get(key);
    if (!entry) {
      entry = { cohort, contentKind, survivalRates: [], churnRates: [], deletionRates: [], latestMs: 0 };
      windowAcc.set(key, entry);
    }

    entry.survivalRates.push(attrRate(span, ATTR.SURVIVAL_RATE));
    entry.churnRates.push(attrRate(span, ATTR.CHURN_RATE));
    entry.deletionRates.push(attrRate(span, ATTR.DELETION_RATE));

    const spanMs = timestampToMs(span.startTimeUnixNano);
    if (Number.isFinite(spanMs) && spanMs > entry.latestMs) {
      entry.latestMs = spanMs;
    }
  }

  const survivalByAgentWindow: AgentWindowStats[] = [];
  for (const [key, entry] of windowAcc) {
    const [agentName = 'unknown', agentVersion = 'unknown', window = 'unknown'] = key.split(KEY_SEP);
    survivalByAgentWindow.push({
      agentName,
      agentVersion,
      window,
      cohort: entry.cohort,
      contentKind: entry.contentKind,
      avgSurvivalRate: avg(entry.survivalRates),
      avgChurnRate: avg(entry.churnRates),
      avgDeletionRate: avg(entry.deletionRates),
      checkpointCount: entry.survivalRates.length,
      latestTimestamp: entry.latestMs > 0 ? new Date(entry.latestMs).toISOString() : '',
    });
  }

  // Aggregate invocation spans by (agentName, agentVersion, cohort)
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
    const spanMs = timestampToMs(span.startTimeUnixNano);
    if (Number.isFinite(spanMs) && spanMs > entry.latestMs) {
      entry.latestMs = spanMs;
    }
  }

  const versionRollout: AgentVersionStats[] = [];
  for (const [key, entry] of versionAcc) {
    const [agentName = 'unknown', agentVersion = 'unknown'] = key.split(KEY_SEP);
    versionRollout.push({
      agentName,
      agentVersion,
      cohort: entry.cohort,
      invocationCount: entry.invocationCount,
      latestTimestamp: entry.latestMs > 0 ? new Date(entry.latestMs).toISOString() : '',
    });
  }

  versionRollout.sort((a, b) => b.invocationCount - a.invocationCount);

  return {
    survivalByAgentWindow,
    versionRollout,
    hasData: survivalByAgentWindow.length > 0,
  };
}
