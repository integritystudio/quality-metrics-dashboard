/**
 * Post evaluation records straight to ingest, with no local file or state
 * between producer and cloud (cloud-read migration Phase 3).
 *
 * What makes this safe without `upload-evaluations`' shipped-fingerprint
 * state: every payload carries `evaluationId`, and the ingest worker keeps
 * one row per `(org_id, evaluation_id)` (migration 0015). Re-posting a window
 * is a no-op for everything already stored, so a producer can simply re-send
 * whatever it derives, and a failed run is retried by running it again.
 *
 * Mapping and routing are `upload-evaluations`' own (`mapRecord`,
 * `routeRecord`): a stamped record goes to its account's org with that
 * account's key, a `null` stamp is withheld, and an unstamped one takes the
 * HMAC webhook into `HOME_ORG_ID`. No age guard: the flush dates each row by
 * its `evaluatedAtMs`.
 */

import {
  DEFAULT_INGEST_URL,
  INTER_BATCH_DELAY_MS,
  MAX_BATCH_SIZE,
  WEBHOOK_DESTINATION,
  keyedRequest,
  mapRecord,
  postBatch,
  routeRecord,
  webhookRequest,
  type EvaluationPayload,
  type RouteBasis,
} from './upload-evaluations.js';
import { asString, type AccountIndex } from './account-stamps.js';

export interface PostOptions {
  dryRun: boolean;
  /** Routes unstamped records; an empty index sends them all to the webhook. */
  accounts: AccountIndex;
  /** Injected for tests; defaults to `Date.now()`. */
  nowMs?: number;
}

export interface PostSummary {
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

/**
 * Map, route and post `records` (OTel-shaped, as `toOTelRecord` writes them).
 * Stops at the first rejected batch and reports it in `failure`; everything
 * before it was accepted, and a re-run re-sends the rest without duplicating
 * what landed.
 */
export async function postEvaluationRecords(
  records: readonly unknown[],
  opts: PostOptions,
): Promise<PostSummary> {
  const summary: PostSummary = {
    sent: 0,
    byDestination: {},
    skipped: {},
    withheld: 0,
    heldForKey: {},
    routedBy: { stamp: 0, span: 0, join: 0 },
  };
  const nowMs = opts.nowMs ?? Date.now();
  const batches = new Map<string, EvaluationPayload[]>();

  for (const record of records) {
    const mapped = mapRecord(record, nowMs, Number.POSITIVE_INFINITY);
    if (mapped.skip) {
      summary.skipped[mapped.skip] = (summary.skipped[mapped.skip] ?? 0) + 1;
      continue;
    }
    const { route, basis } = routeRecord(mapped, opts.accounts);
    summary.routedBy[basis]++;
    if (route.kind === 'withheld') {
      summary.withheld++;
      continue;
    }
    if (route.kind === 'keyed' && !asString(process.env[route.ref])) {
      summary.heldForKey[route.ref] = (summary.heldForKey[route.ref] ?? 0) + 1;
      continue;
    }
    const destination = route.kind === 'keyed' ? route.ref : WEBHOOK_DESTINATION;
    const batch = batches.get(destination) ?? [];
    batch.push(mapped.payload!);
    batches.set(destination, batch);
  }

  const secret = asString(process.env.INJECT_HMAC_SECRET);
  if (!opts.dryRun && batches.has(WEBHOOK_DESTINATION) && !secret) {
    summary.failure = 'INJECT_HMAC_SECRET is not set, so unstamped records cannot be signed';
    return summary;
  }
  // asString, not `??`: an empty OBTOOL_INGEST_URL must fall back to the default.
  const baseUrl = asString(process.env.OBTOOL_INGEST_URL) ?? DEFAULT_INGEST_URL;

  for (const [destination, payloads] of batches) {
    for (let i = 0; i < payloads.length; i += MAX_BATCH_SIZE) {
      const chunk = payloads.slice(i, i + MAX_BATCH_SIZE);
      if (!opts.dryRun) {
        const request = destination === WEBHOOK_DESTINATION
          ? webhookRequest(baseUrl, chunk, secret!)
          : keyedRequest(baseUrl, chunk, process.env[destination]!);
        const res = await postBatch(request);
        if (!res.ok) {
          summary.failure = `POST to ${destination} failed: ${res.detail}`;
          return summary;
        }
        await new Promise((r) => setTimeout(r, INTER_BATCH_DELAY_MS));
      }
      summary.sent += chunk.length;
      summary.byDestination[destination] = (summary.byDestination[destination] ?? 0) + chunk.length;
    }
  }
  return summary;
}

/** One log line in the same `k=v` shape as upload's summary. */
export function formatPostSummary(summary: PostSummary): string {
  const kv = (counts: Record<string, number>): string =>
    Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  return `sent=${summary.sent} byDestination[${kv(summary.byDestination)}] skipped[${kv(summary.skipped)}]`
    + ` withheld=${summary.withheld} routedBy[${kv(summary.routedBy)}]`
    + (Object.keys(summary.heldForKey).length ? ` heldForKey[${kv(summary.heldForKey)}]` : '')
    + (summary.failure ? ` failure=${summary.failure}` : '');
}
