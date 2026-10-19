import { Hono } from 'hono';
import { loadEvaluationsByMetric } from '../data-loader.js';
import { z } from 'zod';
import { PeriodSchema, InputKeySchema, computePeriodDates } from '../../lib/constants.js';
import { validQuery, handleRouteError } from '../route-errors.js';
import { computeCoverage } from '../aggregates/coverage.js';

export const coverageRoutes = new Hono();
coverageRoutes.onError(handleRouteError);

/**
 * GET /api/coverage
 * Returns the columnar coverage matrix: metrics x inputs counts, with
 * status and gaps derivable by the reader (CVG-1).
 *
 * Query params:
 *   period: '24h' | '7d' | '30d' | '90d' (default: '7d')
 *   inputKey: 'traceId' | 'sessionId' (default: 'traceId')
 */
const CoverageQuery = z.object({ period: PeriodSchema, inputKey: InputKeySchema });

coverageRoutes.get('/coverage', validQuery(CoverageQuery), async (c) => {
  const { period, inputKey } = c.req.valid('query');

  const { start, end } = computePeriodDates(period);

  const allEvaluations = await loadEvaluationsByMetric(start, end);

  // Columnar, matching what sync-to-kv writes to KV and the Worker serves, so
  // the dev server and production hand the grid the same shape (CVG-1).
  const matrix = computeCoverage(allEvaluations, { inputKey });

  return c.json({ period, ...matrix });
});
