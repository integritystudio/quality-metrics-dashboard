/** OTel `[seconds, nanoseconds]` high-resolution time, as the local trace files write it. */

import {
  NANOSECONDS_PER_MILLISECOND,
  NANOSECONDS_PER_MILLISECOND_BIGINT,
  NANOSECONDS_PER_SECOND,
  NANOSECONDS_PER_SECOND_BIGINT,
  TIME_MS,
} from '../../src/lib/core/units.js';

/** Epoch ms as the nanosecond bigint the backend's timestamps and query bounds use. */
export function msToNs(ms: number): bigint {
  return BigInt(ms) * NANOSECONDS_PER_MILLISECOND_BIGINT;
}

/** A nanosecond bigint timestamp as epoch ms. */
export function nsToMs(ns: bigint): number {
  return Number(ns / NANOSECONDS_PER_MILLISECOND_BIGINT);
}

export type HrTime = [number, number];

/** `value` as an HRT tuple, or `undefined` when it is not a `[number, number]`. */
export function asHrTime(value: unknown): HrTime | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  // Array.isArray narrows `unknown` to `any[]`, so name the element type rather
  // than destructure `any`; the typeof guards do the real checking.
  const [s, ns] = value as [unknown, unknown];
  return typeof s === 'number' && typeof ns === 'number' ? [s, ns] : undefined;
}

export function hrtToMs(hrt: HrTime): number {
  return hrt[0] * TIME_MS.SECOND + hrt[1] / NANOSECONDS_PER_MILLISECOND;
}

/** `NaN` rather than a throw on a malformed tuple, so a caller's `Number.isFinite` guard is the one place it is handled (OBP15). */
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
