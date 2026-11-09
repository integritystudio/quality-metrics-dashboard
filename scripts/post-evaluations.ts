/**
 * Post evaluation records straight to ingest, with no local file or state
 * between producer and cloud (cloud-read migration Phase 3).
 *
 * What makes this safe without local state: every payload carries
 * `evaluationId`, and the ingest worker keeps one row per
 * `(org_id, evaluation_id)` (migration 0015). Re-posting a window
 * is a no-op for everything already stored, so a producer can simply re-send
 * whatever it derives, and a failed run is retried by running it again.
 *
 * Mapping and routing are `evaluation-delivery`'s (`mapRecord`,
 * `routeRecord`): a stamped record goes to its account's org with that
 * account's key, a `null` stamp is withheld, and an unstamped one takes the
 * HMAC webhook into `HOME_ORG_ID`. The flush dates each row by its
 * `evaluatedAtMs`, however old.
 */

import {
  INGEST_URL_NOT_SET_MESSAGE,
  INTER_BATCH_DELAY_MS,
  MAX_BATCH_SIZE,
  WEBHOOK_DESTINATION,
  deliveryFor,
  formatCounts,
  mapRecord,
  resolveSendConfig,
  routeRecord,
  sendBatch,
  type EvaluationPayload,
  type MapSkip,
  type Route,
  type RouteBasis,
} from './evaluation-delivery.js';
import type { AccountIndex } from './account-stamps.js';
import { sleep } from './sleep.js';
import { increment, pushTo } from './collections.js';

export type PostOptions = {
  dryRun: boolean;
  /** Routes unstamped records; an empty index sends them all to the webhook. */
  accounts: AccountIndex;
}

/**
 * One record, mapped and routed once for everything that reads it: the post,
 * and the judge's log-event backup, whose id is then the posted one by construction.
 */
export type RoutedRecord =
  | { skip: MapSkip }
  | { skip?: undefined; record: Record<string, unknown>; payload: EvaluationPayload; route: Route; basis: RouteBasis };

export type PostSummary = {
  /** Accepted by ingest (or, on a dry run, would have been sent). */
  sent: number;
  byDestination: Record<string, number>;
  skipped: Record<string, number>;
  /** Stamped `null`: an unmapped account, never sent (TKR3). */
  withheld: number;
  /** Stamped for an account whose key is not in the environment. */
  heldForKey: Record<string, number>;
  routedBy: Record<RouteBasis, number>;
  /** The first rejected batch, when one was; nothing after it was sent. */
  failure?: string;
}

export function emptyAccountIndex(): AccountIndex {
  return { sessionSpans: new Map(), bySpan: new Map() };
}

/** Map and route each of `records` (OTel-shaped, as `toOTelRecord` writes them). */
export function routeEvaluationRecords(records: readonly unknown[], accounts: AccountIndex): RoutedRecord[] {
  return records.map((record): RoutedRecord => {
    const mapped = mapRecord(record);
    if (mapped.skip) return { skip: mapped.skip };
    const { route, basis } = routeRecord(mapped, accounts);
    return { record: record as Record<string, unknown>, payload: mapped.payload, route, basis };
  });
}

/** One batch per destination, counting everything that ships nowhere as it goes. */
function batchRecords(routed: readonly RoutedRecord[], summary: PostSummary): Map<string, EvaluationPayload[]> {
  const batches = new Map<string, EvaluationPayload[]>();
  for (const entry of routed) {
    if (entry.skip) {
      increment(summary.skipped, entry.skip);
      continue;
    }
    summary.routedBy[entry.basis]++;
    const delivery = deliveryFor(entry.route);
    if (delivery.kind === 'withheld') {
      summary.withheld++;
      continue;
    }
    if (delivery.kind === 'held-for-key') {
      increment(summary.heldForKey, delivery.ref);
      continue;
    }
    pushTo(batches, delivery.destination, entry.payload);
  }
  return batches;
}

/** Map, route and post `records` (OTel-shaped, as `toOTelRecord` writes them). */
export async function postEvaluationRecords(records: readonly unknown[], opts: PostOptions): Promise<PostSummary> {
  return postRoutedRecords(routeEvaluationRecords(records, opts.accounts), opts.dryRun);
}

/**
 * Post records already routed. Stops at the first rejected batch and reports
 * it in `failure`; everything before it was accepted, and a re-run re-sends
 * the rest without duplicating what landed.
 */
export async function postRoutedRecords(routed: readonly RoutedRecord[], dryRun: boolean): Promise<PostSummary> {
  const summary: PostSummary = {
    sent: 0,
    byDestination: {},
    skipped: {},
    withheld: 0,
    heldForKey: {},
    routedBy: { stamp: 0, span: 0, join: 0 },
  };
  const batches = batchRecords(routed, summary);

  const { baseUrl, secret } = resolveSendConfig();
  if (!dryRun && batches.has(WEBHOOK_DESTINATION) && !secret) {
    summary.failure = 'INJECT_HMAC_SECRET is not set, so unstamped records cannot be signed';
    return summary;
  }
  if (!dryRun && !baseUrl) {
    summary.failure = INGEST_URL_NOT_SET_MESSAGE;
    return summary;
  }

  for (const [destination, payloads] of batches) {
    for (let i = 0; i < payloads.length; i += MAX_BATCH_SIZE) {
      const chunk = payloads.slice(i, i + MAX_BATCH_SIZE);
      if (!dryRun) {
        // eslint-disable-next-line no-await-in-loop -- batches are paced below and abort on the first failure
        const res = await sendBatch(destination, chunk, baseUrl, secret);
        if (!res.ok) {
          summary.failure = `POST to ${destination} failed: ${res.detail}`;
          return summary;
        }
        // eslint-disable-next-line no-await-in-loop -- the pacing delay between batches is the point
        await sleep(INTER_BATCH_DELAY_MS);
      }
      summary.sent += chunk.length;
      increment(summary.byDestination, destination, chunk.length);
    }
  }
  return summary;
}

/**
 * Of `total` records posted, those neither accepted nor dropped for good: the
 * batches from the failed one on, and any held for a missing key. Skipped and
 * withheld records never ship, so a re-post would not deliver them either.
 */
export function undeliveredCount(total: number, summary: PostSummary): number {
  const skipped = Object.values(summary.skipped).reduce((sum, n) => sum + n, 0);
  return total - summary.sent - skipped - summary.withheld;
}

/** One log line in the same `k=v` shape as upload's summary. */
export function formatPostSummary(summary: PostSummary): string {
  return `sent=${summary.sent} byDestination[${formatCounts(summary.byDestination)}] skipped[${formatCounts(summary.skipped)}]`
    + ` withheld=${summary.withheld} routedBy[${formatCounts(summary.routedBy)}]${
      Object.keys(summary.heldForKey).length ? ` heldForKey[${formatCounts(summary.heldForKey)}]` : ''
    }${summary.failure ? ` failure=${summary.failure}` : ''}`;
}
