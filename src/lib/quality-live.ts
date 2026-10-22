/**
 * The live quality view, built the same way by the API server (from evaluations
 * it loads) and the Worker (from the `metric:evaluations:*` rows sync-to-kv
 * writes). Worker-safe: imports nothing that reaches Node or import.meta.env.
 */

import { timestampToMs } from './timestamps.js';
import { QUALITY_LIVE_EVAL_LIMIT } from './worker-contract.js';
import type { LiveMetric, QualityLiveData } from '../types.js';

/** `evaluatorType` for an evaluation that does not name one. */
export const UNKNOWN_EVALUATOR_TYPE = 'unknown';

export type LiveEvaluation = {
  score?: number | null | undefined;
  evaluatorType?: string | null | undefined;
  timestamp: string | number | bigint;
  traceId?: string | null | undefined;
};

function toIso(ms: number, fallback: string): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/**
 * Each metric's newest evaluation, when it is scored, and the distinct traces
 * among each metric's newest {@link QUALITY_LIVE_EVAL_LIMIT}. Every metric's
 * evaluations must arrive newest first.
 */
export function summarizeQualityLive(
  evaluationsByMetric: Iterable<readonly [string, readonly LiveEvaluation[]]>,
  now: Date,
): QualityLiveData {
  const metrics: LiveMetric[] = [];
  const traceIds = new Set<string>();
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const [name, evaluations] of evaluationsByMetric) {
    const recent = evaluations.slice(0, QUALITY_LIVE_EVAL_LIMIT);
    for (const ev of recent) {
      if (ev.traceId) traceIds.add(ev.traceId);
    }
    const latest = recent[0];
    if (latest?.score == null) continue;
    const ms = timestampToMs(latest.timestamp);
    metrics.push({
      name,
      score: latest.score,
      evaluatorType: latest.evaluatorType ?? UNKNOWN_EVALUATOR_TYPE,
      timestamp: toIso(ms, String(latest.timestamp)),
    });
    if (Number.isFinite(ms)) latestMs = Math.max(latestMs, ms);
  }

  metrics.sort((a, b) => a.name.localeCompare(b.name));
  return {
    metrics,
    sessionCount: traceIds.size,
    lastUpdated: toIso(latestMs, now.toISOString()),
  };
}
