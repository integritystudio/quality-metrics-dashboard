/**
 * The agent activity list (`GET /api/agents`), built once for both the API
 * route (`routes/agents.ts`) and the KV sync (`scripts/sync-to-kv.ts`). The sync
 * once wrote its own summary list to `meta:agents`, which the page rejected as
 * missing `period` and `agents` (DASHBOARD-AGGREGATE-DUAL-IMPL).
 *
 * Callers load the spans and evaluations; this module only projects them, so
 * one fixture through both paths yields the same value.
 */

import { mean } from 'd3-array';
import {
  KNOWN_SOURCE_TYPES,
  MAX_IDS,
  SCORE_DISPLAY_PRECISION,
  TIME_MS,
  VALID_PERIODS,
  type Period,
} from '../../lib/constants.js';
import {
  HOOK_NAME,
  attrNum,
  attrStr,
  incrementCount,
  spanAttr,
  timestampToMs,
  toDateOnly,
  type SpanLike,
} from '../api-constants.js';
import { GENAI_AGENT_ATTRIBUTES, SESSION_ATTRIBUTES } from '../../lib/otel-attributes.js';

/** One KV key per period; the Worker restates the prefix because it cannot import this module. */
export const AGENT_STATS_KEY_PREFIX = 'meta:agents:';

export function agentStatsKey(period: Period): string {
  return `${AGENT_STATS_KEY_PREFIX}${period}`;
}

/** The span attribute the agents read filters on; its value is `HOOK_NAME.AGENT_FINALIZE`. */
export const HOOK_NAME_ATTRIBUTE = 'integritystudio.hook.name';

export type AgentStatsSpan = SpanLike & {
  traceId?: string;
  startTimeUnixNano?: string | number | bigint | null;
};

export type AgentStatsEvaluation = {
  traceId?: string;
  evaluationName: string;
  scoreValue?: number | null;
};

export interface EvalMetricSummary {
  avg: number;
  min: number;
  max: number;
  count: number;
}

export interface AgentStat {
  agentName: string;
  invocations: number;
  errors: number;
  errorRate: number;
  rateLimitCount: number;
  avgOutputSize: number;
  /** Unique sessions; always >= `sessionIds.length`. */
  sessionCount: number;
  sessionIds: string[];
  sessionIdsTruncated: boolean;
  traceIdsTotal: number;
  traceIds: string[];
  traceIdsTruncated: boolean;
  sourceTypes: Record<string, number>;
  dailyCounts: number[];
  evalSummary: Record<string, EvalMetricSummary>;
}

export interface AgentStatsResponse {
  period: Period;
  startDate: string;
  endDate: string;
  agents: AgentStat[];
}

export interface AgentStatsWindow {
  periodDays: number;
  windowStart: Date;
  /** Date-only: the response contract and the daily bucket keys. */
  startDate: string;
  endDate: string;
}

export function agentStatsWindow(period: Period, now: Date): AgentStatsWindow {
  const periodDays = VALID_PERIODS[period];
  if (periodDays === undefined) throw new Error(`Unknown period: ${period}`);
  const windowStart = new Date(now.getTime() - periodDays * TIME_MS.DAY);
  return { periodDays, windowStart, startDate: toDateOnly(windowStart), endDate: toDateOnly(now) };
}

export function isAgentFinalizeSpan(span: SpanLike): boolean {
  return attrStr(span, HOOK_NAME_ATTRIBUTE, '') === HOOK_NAME.AGENT_FINALIZE;
}

type AgentAcc = {
  invocations: number;
  errors: number;
  rateLimitCount: number;
  totalOutputSize: number;
  sessions: Set<string>;
  traceIds: Set<string>;
  sourceTypes: Record<string, number>;
  dailyCounts: number[];
};

function createAgentAccumulator(periodDays: number): AgentAcc {
  return {
    invocations: 0,
    errors: 0,
    rateLimitCount: 0,
    totalOutputSize: 0,
    sessions: new Set(),
    traceIds: new Set(),
    sourceTypes: Object.create(null) as Record<string, number>,
    dailyCounts: new Array<number>(periodDays).fill(0),
  };
}

function computeEvalMetricSummary(scores: number[]): EvalMetricSummary {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    avg: +(mean(sorted) ?? 0).toFixed(SCORE_DISPLAY_PRECISION),
    min: +(sorted[0] ?? 0).toFixed(SCORE_DISPLAY_PRECISION),
    max: +(sorted[sorted.length - 1] ?? 0).toFixed(SCORE_DISPLAY_PRECISION),
    count: sorted.length,
  };
}

/**
 * Per-agent activity over `spans` (agent-finalize spans in the period), with
 * evaluation summaries from the `evaluations` whose trace an agent ran in.
 * Evaluations on other traces are ignored, so callers may pass a superset.
 */
export function computeAgentStats(
  spans: AgentStatsSpan[],
  evaluations: AgentStatsEvaluation[],
  period: Period,
  now: Date,
): AgentStatsResponse {
  const { periodDays, startDate, endDate } = agentStatsWindow(period, now);

  const bucketIndex = new Map<string, number>();
  for (let d = 0; d < periodDays; d++) {
    bucketIndex.set(toDateOnly(new Date(now.getTime() - (periodDays - 1 - d) * TIME_MS.DAY)), d);
  }

  const acc = Object.create(null) as Record<string, AgentAcc>;
  const traceToAgents = new Map<string, Set<string>>();

  for (const span of spans) {
    const name = attrStr(span, GENAI_AGENT_ATTRIBUTES.AGENT_NAME);
    const entry = (acc[name] ??= createAgentAccumulator(periodDays));
    entry.invocations++;
    if (span.startTimeUnixNano) {
      const idx = bucketIndex.get(toDateOnly(new Date(timestampToMs(span.startTimeUnixNano))));
      if (idx !== undefined) entry.dailyCounts[idx] = (entry.dailyCounts[idx] ?? 0) + 1;
    }
    if (spanAttr(span, 'integritystudio.agent.has_error', 'boolean')) entry.errors++;
    if (spanAttr(span, 'integritystudio.agent.has_rate_limit', 'boolean')) entry.rateLimitCount++;
    entry.totalOutputSize += attrNum(span, 'integritystudio.agent.output_size');
    const sid = attrStr(span, SESSION_ATTRIBUTES.ID, '');
    if (sid) entry.sessions.add(sid);
    if (span.traceId) {
      entry.traceIds.add(span.traceId);
      let agentSet = traceToAgents.get(span.traceId);
      if (!agentSet) traceToAgents.set(span.traceId, agentSet = new Set());
      agentSet.add(name);
    }
    const rawSrc = attrStr(span, 'integritystudio.agent.source_type');
    incrementCount(entry.sourceTypes, KNOWN_SOURCE_TYPES.has(rawSrc) ? rawSrc : 'other');
  }

  const agentEvalAcc = Object.create(null) as Record<string, Record<string, number[]>>;
  for (const ev of evaluations) {
    if (!ev.traceId || ev.scoreValue == null || !Number.isFinite(ev.scoreValue)) continue;
    const agentNames = traceToAgents.get(ev.traceId);
    if (!agentNames) continue;
    for (const agent of agentNames) {
      const metrics = (agentEvalAcc[agent] ??= Object.create(null) as Record<string, number[]>);
      (metrics[ev.evaluationName] ??= []).push(ev.scoreValue);
    }
  }

  const agents = Object.entries(acc).map(([agentName, d]): AgentStat => {
    const evalSummary: Record<string, EvalMetricSummary> = {};
    for (const [metric, scores] of Object.entries(agentEvalAcc[agentName] ?? {})) {
      evalSummary[metric] = computeEvalMetricSummary(scores);
    }
    const sessionIdList = [...d.sessions];
    const traceIdList = [...d.traceIds];
    return {
      agentName,
      invocations: d.invocations,
      errors: d.errors,
      errorRate: d.invocations > 0 ? +(d.errors / d.invocations).toFixed(SCORE_DISPLAY_PRECISION) : 0,
      rateLimitCount: d.rateLimitCount,
      avgOutputSize: d.invocations > 0 ? Math.round(d.totalOutputSize / d.invocations) : 0,
      sessionCount: d.sessions.size,
      sessionIds: sessionIdList.slice(0, MAX_IDS),
      sessionIdsTruncated: sessionIdList.length > MAX_IDS,
      traceIdsTotal: traceIdList.length,
      traceIds: traceIdList.slice(0, MAX_IDS),
      traceIdsTruncated: traceIdList.length > MAX_IDS,
      sourceTypes: d.sourceTypes,
      dailyCounts: d.dailyCounts,
      evalSummary,
    };
  }).sort((a, b) => b.invocations - a.invocations);

  return { period, startDate, endDate, agents };
}
