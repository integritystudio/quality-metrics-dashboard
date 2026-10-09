import { Hono } from 'hono';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { PeriodSchema, InputKeySchema, ErrorMessage, computePeriodDates } from '../../lib/constants.js';
import { parseParam, handleRouteError } from '../route-errors.js';
import { computeCoverage } from '../aggregates/coverage.js';

export const coverageRoutes = new Hono();
coverageRoutes.onError(handleRouteError);

/**
 * GET /api/coverage
 * Returns the columnar coverage matrix: metrics x inputs counts, with
 * status and gaps derivable by the reader (CVG-1).
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' (default: '7d')
 *   inputKey: 'traceId' | 'sessionId' (default: 'traceId')
 */
coverageRoutes.get('/coverage', async (c) => {
  const period = parseParam(PeriodSchema, c.req.query('period'), ErrorMessage.InvalidPeriod);
  const inputKey = parseParam(InputKeySchema, c.req.query('inputKey'), ErrorMessage.InvalidInputKey);

  const { start, end } = computePeriodDates(period);

  const allEvaluations = await loadEvaluationsByMetric(start, end);

  // Columnar, matching what sync-to-kv writes to KV and the Worker serves, so
  // the dev server and production hand the grid the same shape (CVG-1).
  const matrix = computeCoverage(allEvaluations, { inputKey });

  return c.json({ period, ...matrix });
});
