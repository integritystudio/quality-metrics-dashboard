/**
 * The per-trace KV entries, one builder per trace: the CLI (`org-kv-entries.ts`)
 * loops it over every trace a whole org's evaluations name, the Workflow
 * (`services/kv-sync-workflow`) over one batch of trace ids per step. The two
 * write byte-identical values for the parity gate in
 * `docs/roadmap/kv-sync-in-worker.md`.
 */

import type { EvaluationResult, TraceSpan } from '../../types.js';
import { KV_ENTRY_TTL_SECONDS, toKVValue, type KVEntry } from './kv-entry.js';

export const TRACE_KEY_PREFIX = 'trace:';
export const TRACE_EVALS_KEY_PREFIX = 'evaluations:trace:';

/**
 * `evaluations:trace:<id>` and `trace:<id>` for one trace: its evaluations
 * newest id first and its spans newest start first, as the reads return them.
 * Spans/evaluations carry bigint timestamps, hence toKVValue.
 */
export function traceEntries(traceId: string, evaluations: EvaluationResult[], spans: TraceSpan[]): KVEntry[] {
  return [
    {
      key: `${TRACE_EVALS_KEY_PREFIX}${traceId}`,
      value: toKVValue({ evaluations }),
      expirationTtl: KV_ENTRY_TTL_SECONDS,
    },
    {
      key: `${TRACE_KEY_PREFIX}${traceId}`,
      value: toKVValue({ traceId, spans, evaluations }),
      expirationTtl: KV_ENTRY_TTL_SECONDS,
    },
  ];
}

/** The pair for every trace in `traceIds`, in that order, from the whole-org maps the CLI holds. */
export function buildTraceEntries(
  traceIds: string[],
  evalsByTrace: Map<string, EvaluationResult[]>,
  spansByTrace: Map<string, TraceSpan[]>,
): KVEntry[] {
  return traceIds.flatMap(traceId => traceEntries(traceId, evalsByTrace.get(traceId) ?? [], spansByTrace.get(traceId) ?? []));
}
