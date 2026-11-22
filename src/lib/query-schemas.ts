import { z } from 'zod';
import { INVALID_PERIOD_MESSAGE, PeriodEnum, type Period } from './periods.js';
import { ROLES } from './roles.js';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './worker-contract.js';

/**
 * Query-string and path-parameter rules the Worker and the dev API server both validate
 * with, and the 400 message each answers with. Worker-safe: zod and the other worker-safe
 * modules only.
 */

const OR_LIST = new Intl.ListFormat('en', { type: 'disjunction' });

/** Joins allowed values as "a, b, or c" for the 400 messages, so they follow the shared lists. */
export function orList(values: Iterable<string>): string {
  return OR_LIST.format(values);
}

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

const MAX_PARAM_LEN = 200;
/** A metric name, trace id, session id or agent id in a path. */
export const ID_PATTERN = new RegExp(`^[\\w:.-]{1,${MAX_PARAM_LEN}}$`);

export const ERR_INVALID_QUERY = 'Invalid query parameters';
export const ERR_INVALID_ROLE = `Invalid role. Must be ${orList(ROLES)}.`;
export const ERR_INVALID_PAGINATION = `Invalid pagination params. limit must be 1–${MAX_PAGE_LIMIT}, offset must be >= 0.`;
export const ERR_INVALID_SORT_BY = `Invalid sortBy. Must be ${orList(SORT_BY_VALUES)}.`;
export const ERR_INVALID_INPUT_KEY = `Invalid inputKey. Must be ${orList(COVERAGE_INPUT_KEYS)}.`;
export const ERR_INVALID_METRIC_NAME = 'Invalid metric name';
export const ERR_INVALID_TRACE_ID = 'Invalid traceId';
export const ERR_INVALID_SESSION_ID = 'Invalid sessionId';

/** The error each shared query field answers with; a schema reports issues in shape order. */
export const QUERY_FIELD_ERRORS: Readonly<Record<string, string>> = {
  period: INVALID_PERIOD_MESSAGE,
  role: ERR_INVALID_ROLE,
  limit: ERR_INVALID_PAGINATION,
  offset: ERR_INVALID_PAGINATION,
  sortBy: ERR_INVALID_SORT_BY,
  inputKey: ERR_INVALID_INPUT_KEY,
};
