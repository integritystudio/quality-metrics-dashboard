/**
 * A KV entry as the sync writers hand it to Cloudflare: the serialised value and,
 * when the value carries run-time fields, the basis change detection hashes
 * instead. Shared by the CLI sync (`scripts/sync-to-kv.ts`) and the Workflow
 * (`services/kv-sync-workflow`), which must hash a given view identically for
 * the parity gate in `docs/roadmap/kv-sync-in-worker.md`.
 */

import { bigintReplacer } from '../api-constants.js';
import { SECONDS } from '../parent/units.js';

const LOG_PREFIX = '[kv-entry]';

/** `hashBasis`, when set, is what change detection hashes instead of `value`. */
export type KVEntry = { key: string; value: string; expirationTtl?: number; hashBasis?: string };

/** The literal `worker/index.ts` reads at GET /api/degradation-signals; keep the two in step. */
export const DEGRADATION_KV_KEY = 'meta/dashboard/degradation-signals';

/**
 * The key families the Workflow writes and the CLI no longer does, as each
 * logical key's prefix (no `org:<id>:`). Both writers read this one list, so a
 * family has exactly one writer: adding a prefix here hands it over on the
 * CLI's next run, and the Workflow takes it at its next deploy. Deploy the
 * Workflow after the CLI picks the change up, never before, or both write it.
 */
export const WORKFLOW_OWNED_FAMILIES: readonly string[] = ['correlations:', 'coverage:', 'pipeline:', 'dashboard:', 'metric:', 'trend:', `${DEGRADATION_KV_KEY}:`, 'session:', 'trace:', 'evaluations:trace:'];

/** Whether the Workflow is the writer of this logical key (org prefix already stripped). */
export function isWorkflowOwnedKey(logicalKey: string, families: readonly string[] = WORKFLOW_OWNED_FAMILIES): boolean {
  return families.some(prefix => logicalKey.startsWith(prefix));
}

/**
 * TTL for per-trace and per-session KV entries (seconds).
 * Must exceed the longest `--days` query window so entries are not prematurely expired.
 * 90 days is 3x the default 30-day window and prevents unbounded key accumulation.
 */
export const KV_ENTRY_TTL_DAYS = 90;
export const KV_ENTRY_TTL_SECONDS = SECONDS.DAY * KV_ENTRY_TTL_DAYS;

/**
 * Serialize a KV entry value. Backend spans and evaluations carry `bigint`
 * timestamps (`startTimeUnixNano`, `endTimeUnixNano`, `timestamp`) that
 * `JSON.stringify` throws on; the replacer writes them in their decimal-string
 * wire form, which `timestampToMs` on the read side already accepts. Every KV
 * entry value must be built through this, never bare `JSON.stringify` — the
 * bigint-bearing types nest at varying depth (SYNC-KV-BIGINT). A replacer
 * rather than `jsonSafe`, which deep-copies the value before it is serialized.
 *
 * Throws when the value has no JSON form (`undefined`, a function, a symbol):
 * `JSON.stringify` returns `undefined` for those, and `kvBulkPut` splices the
 * value into its envelope as text, so nothing later would catch it
 * (KV-VALUE-NOT-JSON-UNGUARDED).
 */
export function toKVValue(value: unknown): string {
  const json: string | undefined = JSON.stringify(value, bigintReplacer);
  if (typeof json !== 'string') throw new TypeError(`${LOG_PREFIX} KV value has no JSON form (${typeof value})`);
  return json;
}

/** The view's own run-time stamp; a nested `timestamp` (`worstExplanation.timestamp`) is event time, i.e. data. */
const DASHBOARD_RUN_STAMP_FIELD = 'timestamp';
/** Each metric's query window, built from the run's `now`, at any depth. */
const DASHBOARD_PERIOD_FIELD = 'period';
/**
 * Sparkline bucket indices shift with the exact `now` — two runs on the same UTC
 * day over the same data disagree on which bucket holds an evaluation unless the
 * boundaries are day-aligned. Exclude from the hash so the key is not rewritten
 * solely because the run time moved within the same day (SYNC-DASHBOARD-TIMESTAMP-WRITES).
 */
const DASHBOARD_SPARKLINES_FIELD = 'sparklines';

/**
 * A dashboard summary or role view as a KV entry. The view's top-level `timestamp`,
 * each metric's `period`, and `sparklines` come from the run's clock, so the change
 * hash leaves them out and a sync over unchanged data rewrites no `dashboard:*` key
 * (SYNC-DASHBOARD-TIMESTAMP-WRITES). The stored value keeps them, so they show the
 * run that last changed the data, not the latest run.
 */
export function dashboardEntry(key: string, view: object): KVEntry {
  const hashBasis = JSON.stringify(view, function (this: unknown, field: string, v: unknown) {
    if (field === DASHBOARD_PERIOD_FIELD) return undefined;
    if (field === DASHBOARD_SPARKLINES_FIELD) return undefined;
    if (field === DASHBOARD_RUN_STAMP_FIELD && this === view) return undefined;
    return bigintReplacer(field, v);
  });
  return { key, value: toKVValue(view), hashBasis };
}
