import {
  NANOSECONDS_PER_MILLISECOND,
  NANOSECONDS_PER_MILLISECOND_BIGINT,
  NANOSECONDS_PER_SECOND,
  NANOSECONDS_PER_SECOND_BIGINT,
  TIME_MS,
} from '../../src/lib/core/units.js';

export function msToNs(ms: number): bigint {
  return BigInt(ms) * NANOSECONDS_PER_MILLISECOND_BIGINT;
}

export function nsToMs(ns: bigint): number {
  return Number(ns / NANOSECONDS_PER_MILLISECOND_BIGINT);
}

/** OTel `[seconds, nanoseconds]`, as the local trace files write it. */
export type HrTime = [number, number];

export function asHrTime(value: unknown): HrTime | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  // `Array.isArray` narrows to `any[]`; the typeof guards do the real checking.
  const [s, ns] = value as [unknown, unknown];
  return typeof s === 'number' && typeof ns === 'number' ? [s, ns] : undefined;
}

export function hrtToMs(hrt: HrTime): number {
  return hrt[0] * TIME_MS.SECOND + hrt[1] / NANOSECONDS_PER_MILLISECOND;
}

/** `NaN` on a malformed tuple, never a throw: the caller's `Number.isFinite` guard is the one handler (OBP15). */
export function hrtToSeconds(hrt: HrTime): number {
  if (!Array.isArray(hrt)) return NaN;
  return hrt[0] + hrt[1] / NANOSECONDS_PER_SECOND;
}

export function hrtToISO(hrt: HrTime): string {
  return new Date(hrtToMs(hrt)).toISOString();
}

export function nanosToHrt(ns: bigint): HrTime {
  return [Number(ns / NANOSECONDS_PER_SECOND_BIGINT), Number(ns % NANOSECONDS_PER_SECOND_BIGINT)];
}
