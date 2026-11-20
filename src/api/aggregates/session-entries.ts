/**
 * The session and agent KV entries, one builder per partition: `session:<id>`
 * from one session's spans and evaluations, `agent:<name>` folded one session
 * at a time into bounded accumulators, and `meta:agents:<period>` from a
 * period's agent-finalize spans. The CLI (`org-kv-entries.ts`) loops these over
 * a whole org held in memory; the Workflow (`services/kv-sync-workflow`) calls
 * them one session or period per step, so the two write byte-identical values
 * for the parity gate in `docs/roadmap/kv-sync-in-worker.md`.
 */

import { descending, minIndex, quantile } from 'd3-array';
import { computeMultiAgentEvaluation } from '../parent/quality-multi-agent.js';
import type { EvaluationResult, TraceSpan } from '../../types.js';
import { PERCENT_MULTIPLIER, type Period } from '../../lib/constants.js';
import { SESSION_ATTRIBUTES } from '../../lib/otel-attributes.js';
import { buildWorkflowGraph } from '../../lib/workflow-graph.js';
import { LATENCY_P95, RATE_DISPLAY_PRECISION, timestampToMs } from '../api-constants.js';
import { computeSessionDetail, type AgentActivityEntry } from '../session-detail.js';
import { agentStatsKey, agentStatsWindow, computeAgentStats, type AgentStatsEvaluation } from './agent-stats.js';
import { KV_ENTRY_TTL_SECONDS, toKVValue, type KVEntry } from './kv-entry.js';

const MAX_SESSION_DURATIONS = 10_000;
const MAX_AGENT_SESSIONS = 100;
const MAX_RECENT_SESSIONS = 20;

export function spanSessionId(span: { attributes?: Record<string, unknown> | undefined }): string | undefined {
  return (span.attributes?.[SESSION_ATTRIBUTES.ID] ?? span.attributes?.session_id) as string | undefined;
}

/** In-memory cross-session accumulator for a single agent. Never serialized directly. */
export type AgentAccumulator = {
  totalInvocations: number;
  totalErrors: number;
  rateLimitEvents: number;
  totalOutputSize: number;
  weightedDurationSum: number;
  sessionDurations: number[];
  truncatedCount: number;
  emptyCount: number;
  totalSessionCount: number;
  lastSeenDate: string | null;
  sessions: Array<{
    sessionId: string;
    invocations: number;
    errors: number;
    hasRateLimit: boolean;
    avgDurationMs: number;
    date: string | null;
    project: string | null;
  }>;
}

/** What one session contributes to the `agent:` entries: its per-agent activity, its start and its project. */
export type SessionAgentActivity = {
  sessionId: string;
  agents: AgentActivityEntry[];
  /** The session's first evaluation time (ISO 8601 UTC), or null without one. */
  date: string | null;
  project: string | null;
};

export type SessionEntryInput = {
  sessionId: string;
  /** The session's spans, newest start first. */
  spans: TraceSpan[];
  /** The evaluations on the session's traces, newest id first. */
  evaluations: EvaluationResult[];
  /** The evaluation read was cut short, so every evaluation-derived field is partial. */
  evaluationsTruncated: boolean;
};

/**
 * `session:<id>` from one session's rows, plus what the `agent:` entries fold
 * from it. The stored activity drops `totalOutputSize`; the fold keeps it.
 */
export function sessionEntry({ sessionId, spans, evaluations, evaluationsTruncated }: SessionEntryInput): { entry: KVEntry; activity: SessionAgentActivity } {
  const detail = computeSessionDetail({ sessionId, spans, evaluations, evaluationsTruncated }, computeMultiAgentEvaluation);
  const entry: KVEntry = {
    key: `session:${sessionId}`,
    value: toKVValue({
      ...detail,
      agentActivity: detail.agentActivity.map(({ totalOutputSize: _, ...rest }) => rest),
      // The worker has no spans to build this from, so /api/agents/:sessionId
      // serves the graph precomputed here.
      workflowGraph: buildWorkflowGraph(detail.multiAgentEvaluation, spans),
    }),
    expirationTtl: KV_ENTRY_TTL_SECONDS,
  };
  const activity: SessionAgentActivity = {
    sessionId,
    agents: detail.agentActivity,
    date: detail.timespan?.start ?? null,
    project: detail.sessionInfo?.projectName ?? null,
  };
  return { entry, activity };
}

/**
 * Add one session to an agent's bounded buffer of recent sessions. Once the
 * buffer holds `capacity`, a dated entry replaces the oldest dated session (the
 * first of a tie) if it is newer; when no buffered session has a date, it
 * replaces the last slot. An undated entry is dropped from a full buffer.
 */
export function addRecentSession<T extends { date: string | null }>(sessions: T[], entry: T, capacity: number): void {
  if (sessions.length < capacity) {
    sessions.push(entry);
    return;
  }
  if (!entry.date) return;
  const datedIdx = minIndex(sessions, s => s.date);
  const oldestIdx = datedIdx >= 0 ? datedIdx : sessions.length - 1;
  const oldestDate = sessions[oldestIdx]?.date;
  if (!oldestDate || entry.date > oldestDate) {
    sessions[oldestIdx] = entry;
  }
}

/** Fold one session's activity for one agent into that agent's cross-session totals. */
function accumulateAgent(agents: Map<string, AgentAccumulator>, ag: AgentActivityEntry, session: SessionAgentActivity): void {
  let acc = agents.get(ag.agentName);
  if (!acc) {
    acc = {
      totalInvocations: 0, totalErrors: 0, rateLimitEvents: 0,
      totalOutputSize: 0, weightedDurationSum: 0, sessionDurations: [],
      truncatedCount: 0, emptyCount: 0,
      totalSessionCount: 0, lastSeenDate: null, sessions: [],
    };
    agents.set(ag.agentName, acc);
  }
  acc.totalInvocations += ag.invocations;
  acc.totalErrors += ag.errors;
  acc.rateLimitEvents += ag.rateLimitEvents;
  acc.totalOutputSize += ag.totalOutputSize;
  acc.truncatedCount += ag.truncatedCount;
  acc.emptyCount += ag.emptyCount;
  // One duration entry per session; capped to bound memory for p95 computation
  if (ag.avgDurationMs > 0) {
    acc.weightedDurationSum += ag.avgDurationMs * ag.invocations;
    if (acc.sessionDurations.length < MAX_SESSION_DURATIONS) {
      acc.sessionDurations.push(ag.avgDurationMs);
    }
  }
  // sessionDate is always ISO 8601 UTC (from toISOString()), so
  // lexicographic comparison is equivalent to chronological ordering.
  acc.totalSessionCount++;
  if (session.date && (!acc.lastSeenDate || session.date > acc.lastSeenDate)) {
    acc.lastSeenDate = session.date;
  }
  addRecentSession(acc.sessions, {
    sessionId: session.sessionId,
    invocations: ag.invocations,
    errors: ag.errors,
    hasRateLimit: ag.hasRateLimit,
    avgDurationMs: ag.avgDurationMs,
    date: session.date,
    project: session.project,
  }, MAX_AGENT_SESSIONS);
}

/**
 * Fold one session into the per-agent accumulators. Order matters: the recent-
 * session buffer and the duration cap keep the first sessions folded, so both
 * writers fold sessions in the order the span read first names them.
 */
export function accumulateSessionAgents(agents: Map<string, AgentAccumulator>, session: SessionAgentActivity): void {
  for (const ag of session.agents) accumulateAgent(agents, ag, session);
}

/** `agent:<name>` per accumulated agent. */
export function agentEntries(agents: Map<string, AgentAccumulator>, now: Date): KVEntry[] {
  const entries: KVEntry[] = [];
  const computedAt = now.toISOString();

  for (const [agentName, acc] of agents) {
    // ISO 8601 sorts lexicographically — take most recent sessions first
    const sessions = acc.sessions
      .slice()
      .toSorted((a, b) => descending(a.date ?? '', b.date ?? ''))
      .slice(0, MAX_RECENT_SESSIONS);
    const perInvocation = (total: number): number => (acc.totalInvocations > 0 ? total / acc.totalInvocations : 0);
    const rate = (count: number): number => +perInvocation(count).toFixed(RATE_DISPLAY_PRECISION);

    const detail = {
      agentName,
      totalSessions: acc.totalSessionCount,
      totalInvocations: acc.totalInvocations,
      totalErrors: acc.totalErrors,
      errorRate: rate(acc.totalErrors),
      rateLimitEvents: acc.rateLimitEvents,
      avgOutputSize: Math.round(perInvocation(acc.totalOutputSize)),
      avgDurationMs: Math.round(perInvocation(acc.weightedDurationSum)),
      p95DurationMs: Math.round(quantile(acc.sessionDurations, LATENCY_P95 / PERCENT_MULTIPLIER) ?? 0),
      truncatedRate: rate(acc.truncatedCount),
      emptyOutputRate: rate(acc.emptyCount),
      lastSeen: acc.lastSeenDate,
      computedAt,
      sessions,
    };

    entries.push({ key: `agent:${agentName}`, value: toKVValue(detail) });
  }
  return entries;
}

/**
 * `meta:agents:<period>`: the agents page, from the projection the dev route
 * uses on its live read. `agentSpans` are agent-finalize spans, cut here to
 * those starting inside the period (the exact instant, not the day-rounded
 * read window); `evaluations` are the period's rows, of which the projection
 * keeps only those on an agent's trace.
 */
export function agentStatsEntry(period: Period, agentSpans: TraceSpan[], evaluations: AgentStatsEvaluation[], now: Date): KVEntry {
  const { windowStart } = agentStatsWindow(period, now);
  const spans = agentSpans.filter(span => timestampToMs(span.startTimeUnixNano) >= windowStart.getTime());
  return { key: agentStatsKey(period), value: toKVValue(computeAgentStats(spans, evaluations, period, now)) };
}
