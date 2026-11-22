import { z } from 'zod';
import { PeriodEnum, type Period } from './periods.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './worker-contract.js';

/**
 * Query-string schemas the Worker and the dev API server both validate with. Worker-safe:
 * zod and the other worker-safe modules only.
 */

/** Input axes the coverage matrix is built for: one KV key per (period, axis). */
export const COVERAGE_INPUT_KEYS = ['traceId', 'sessionId'] as const;
export type InputKey = typeof COVERAGE_INPUT_KEYS[number];
export const DEFAULT_INPUT_KEY: InputKey = 'traceId';
export const InputKeySchema = z.enum(COVERAGE_INPUT_KEYS).default(DEFAULT_INPUT_KEY);

export const SORT_BY_VALUES = ['timestamp_desc', 'score_asc', 'score_desc'] as const;
export type SortBy = typeof SORT_BY_VALUES[number];
export const DEFAULT_SORT_BY: SortBy = 'timestamp_desc';
export const SortBySchema = z.enum(SORT_BY_VALUES).default(DEFAULT_SORT_BY);

export const LimitSchema = z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);
export const OffsetSchema = z.coerce.number().int().min(0).default(0);

/** The query of a route that reads only `period`, defaulting to `fallback`. */
export function periodQuery(fallback: Period): z.ZodObject<{ period: z.ZodDefault<typeof PeriodEnum> }> {
  return z.object({ period: PeriodEnum.default(fallback) });
}
