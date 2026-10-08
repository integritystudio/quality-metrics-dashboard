import { Hono } from 'hono';
import { subMilliseconds, formatISO } from 'date-fns';
import { computeMultiAgentEvaluation } from '../parent/quality-multi-agent.js';
import { HttpStatus, PERIOD_MS, ErrorMessage } from '../../lib/constants.js';
import {
  PARAM_ID_RE,
  isValidParam,
  toIsoWindowBound,
  DateBoundParamSchema,
  jsonSafe,
} from '../api-constants.js';
import { computeSessionDetail } from '../session-detail.js';
import {
  loadEvaluationsBySessionId,
  loadLogsBySessionId,
  loadTracesByFilter,
  TRUNCATION_PROBE_ROWS,
} from '../data-loader.js';
import { MAX_QUERY_LIMIT } from '../parent/constants.js';
import { handleRouteError, parseParam } from '../route-errors.js';

export const sessionRoutes = new Hono();
sessionRoutes.onError(handleRouteError);

/**
 * Most spans read for one session. The probe row past it must fit under the
 * parent's query cap, so a longer session comes back flagged `truncated`
 * instead of cut off with no signal.
 */
export const LIMIT_SESSION_SPANS = MAX_QUERY_LIMIT - TRUNCATION_PROBE_ROWS;

async function loadSessionSpans(sessionId: string, startDate?: string, endDate?: string) {
  const now = new Date();
  const end = endDate ?? formatISO(now, { representation: 'date' });
  const start = startDate ?? formatISO(subMilliseconds(now, PERIOD_MS['30d']), { representation: 'date' });
  const rows = await loadTracesByFilter(
    { 'session.id': sessionId },
    toIsoWindowBound(start, 'start'),
    toIsoWindowBound(end, 'end'),
    LIMIT_SESSION_SPANS + TRUNCATION_PROBE_ROWS,
  );
  return { spans: rows.slice(0, LIMIT_SESSION_SPANS), truncated: rows.length > LIMIT_SESSION_SPANS };
}

sessionRoutes.get('/sessions/:sessionId', async (c) => {
  const sessionId = c.req.param('sessionId');
  if (!isValidParam(sessionId, PARAM_ID_RE)) {
    return c.json({ error: ErrorMessage.InvalidSessionIdFormat }, HttpStatus.BadRequest);
  }
  const startDate = parseParam(DateBoundParamSchema, c.req.query('startDate'), ErrorMessage.InvalidDateBound);
  const endDate = parseParam(DateBoundParamSchema, c.req.query('endDate'), ErrorMessage.InvalidDateBound);

  const [{ spans, truncated: spansTruncated }, logs, { evaluations, truncated: evaluationsTruncated }] = await Promise.all([
    loadSessionSpans(sessionId, startDate, endDate),
    loadLogsBySessionId(sessionId, startDate, endDate),
    loadEvaluationsBySessionId(sessionId, startDate, endDate),
  ]);

  return c.json(jsonSafe(computeSessionDetail(
    { sessionId, spans, evaluations, logs, spansTruncated, evaluationsTruncated },
    computeMultiAgentEvaluation,
  )));
});
