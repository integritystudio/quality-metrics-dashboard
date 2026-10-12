/**
 * Timestamp normalization shared by the API server and the SPA. Evaluations and spans
 * carry epoch nanoseconds (bigint, or a number/string of that magnitude); other sources
 * carry epoch milliseconds or ISO 8601 strings.
 */

/** Divisor to convert nanosecond timestamps (OTel UnixNano) to milliseconds. */
export const NANOS_TO_MS = 1_000_000;

/** A numeric timestamp at or above this is read as nanoseconds, below it as milliseconds. */
const NS_THRESHOLD = 1e15;
const NANOS_TO_MS_BIGINT = BigInt(NANOS_TO_MS);

/**
 * Normalize a timestamp to milliseconds. Accepts bigint nanoseconds (OTel UnixNano),
 * numeric ns/ms (auto-detected via magnitude), or ISO 8601 strings.
 * Returns NaN for unparseable inputs.
 */
export function timestampToMs(ts: string | number | bigint | null | undefined): number {
  if (ts == null) return NaN;
  if (typeof ts === 'bigint') return Number(ts / NANOS_TO_MS_BIGINT);
  if (typeof ts === 'number') return ts >= NS_THRESHOLD ? ts / NANOS_TO_MS : ts;
  const asNum = Number(ts);
  if (Number.isFinite(asNum) && asNum >= NS_THRESHOLD) return asNum / NANOS_TO_MS;
  return new Date(ts).getTime();
}
