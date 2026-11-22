import type { Context } from 'hono';
import { z } from 'zod';
import { sanitizeErrorForResponse } from './parent/error-sanitizer.js';
import { getQualityMetric } from './parent/quality-metrics.js';
import { isValidParam } from './api-constants.js';
import type { QualityMetricConfig } from './aggregates/metric-detail.js';
import { ErrorMessage } from '../lib/constants.js';
import { DEFAULT_PERIOD, DEFAULT_PERIOD_DETAIL } from '../lib/periods.js';
import { ERR_INVALID_METRIC_NAME, ERR_INVALID_QUERY, ID_PATTERN, QUERY_FIELD_ERRORS, periodQuery } from '../lib/query-schemas.js';
import { queryValidator } from '../lib/query-validator.js';
import { HttpStatus } from '../lib/http-constants.js';

/** The shared fields' messages, plus the fields only this server reads. */
const DEV_QUERY_FIELD_ERRORS: Readonly<Record<string, string>> = {
  ...QUERY_FIELD_ERRORS,
  topN: ErrorMessage.InvalidTopN,
  bucketCount: ErrorMessage.InvalidBucketCount,
  buckets: ErrorMessage.InvalidBuckets,
  startDate: ErrorMessage.InvalidDateBound,
  endDate: ErrorMessage.InvalidDateBound,
};

/** Route middleware validating the query string; `c.req.valid('query')` reads the result. */
export function validQuery<T extends z.ZodType>(schema: T): ReturnType<typeof queryValidator<T>> {
  return queryValidator(schema, DEV_QUERY_FIELD_ERRORS, ERR_INVALID_QUERY);
}

/** The query of a route that reads only `period`. */
export const PeriodQuery = periodQuery(DEFAULT_PERIOD);

/** The same, for the wider-window views: metric detail, correlations and agents. */
export const WidePeriodQuery = periodQuery(DEFAULT_PERIOD_DETAIL);

/** An empty `?field=` reads as absent, so an optional field takes its default. */
export function blankAsAbsent<T extends z.ZodType>(schema: T): z.ZodPreprocess<T> {
  return z.preprocess((value) => (value === '' ? undefined : value), schema);
}

/** A `:name` metric param and its config, or the 400 (malformed) / 404 (unknown) response the route returns instead. */
export function resolveMetric(c: Context, name: string): { name: string; config: QualityMetricConfig } | Response {
  if (!isValidParam(name, ID_PATTERN)) {
    return c.json({ error: ERR_INVALID_METRIC_NAME }, HttpStatus.BadRequest);
  }
  const config = getQualityMetric(name);
  if (!config) {
    return c.json({ error: `Unknown metric: ${name}` }, HttpStatus.NotFound);
  }
  return { name, config };
}

/** Every route app's `onError`: a sanitized 500. */
export function handleRouteError(err: Error, c: Context): Response {
  return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
}
