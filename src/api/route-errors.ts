import type { Context } from 'hono';
import { z } from 'zod';
import { sanitizeErrorForResponse } from './parent/error-sanitizer.js';
import { ErrorMessage, INVALID_PERIOD_MESSAGE, PeriodSchema } from '../lib/constants.js';
import { queryValidator } from '../lib/query-validator.js';
import { HttpStatus } from '../lib/http-constants.js';

/** The 400 message for each query field a route validates. */
const QUERY_FIELD_ERRORS: Readonly<Record<string, string>> = {
  period: INVALID_PERIOD_MESSAGE,
  role: ErrorMessage.InvalidRole,
  topN: ErrorMessage.InvalidTopN,
  bucketCount: ErrorMessage.InvalidBucketCount,
  buckets: ErrorMessage.InvalidBuckets,
  limit: ErrorMessage.InvalidLimit,
  offset: ErrorMessage.InvalidOffset,
  sortBy: ErrorMessage.InvalidSortBy,
  scoreLabel: ErrorMessage.InvalidScoreLabel,
  inputKey: ErrorMessage.InvalidInputKey,
  startDate: ErrorMessage.InvalidDateBound,
  endDate: ErrorMessage.InvalidDateBound,
};

/** Route middleware validating the query string; `c.req.valid('query')` reads the result. */
export function validQuery<T extends z.ZodType>(schema: T): ReturnType<typeof queryValidator<T>> {
  return queryValidator(schema, QUERY_FIELD_ERRORS, ErrorMessage.InvalidQuery);
}

/** The query of a route that reads only `period`. */
export const PeriodQuery = z.object({ period: PeriodSchema });

/** An empty `?field=` reads as absent, so an optional field takes its default. */
export function blankAsAbsent<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

/** Every route app's `onError`: a sanitized 500. */
export function handleRouteError(err: Error, c: Context): Response {
  return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
}
