/**
 * The worker ↔ client wire contract: values both sides must agree on, defined
 * once so they cannot drift. Worker-safe (no import.meta.env), like roles.ts
 * and org-rbac.ts — importable by worker/index.ts and the frontend alike.
 */

/** Request header naming the client's chosen active org (P5/P6). */
export const ORG_ID_HEADER = 'X-Org-Id';

/** UUID shape. The worker rejects an X-Org-Id, userId or roleId that fails it. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The worker's 404 `error` when the org has no dashboard KV key synced yet. */
export const WORKER_ERR_NO_DATA = 'No data available';

/** The worker's 404 `error` when no calibration has been synced for the org. A new org has none. */
export const WORKER_ERR_NO_CALIBRATION_DATA = 'No calibration data available';

/**
 * Whether a 404 body is the worker's no-data answer carrying `message`: the org
 * exists but nothing has been synced for it yet. For `useApiQuery`'s `onNotFound`,
 * so a new org reads as empty rather than as an error.
 */
export function isWorkerNoData(body: unknown, message: string): boolean {
  return body !== null && typeof body === 'object' && 'error' in body && body.error === message;
}
