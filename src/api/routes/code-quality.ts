import { Hono } from 'hono';
import { loadTracesByFilter } from '../data-loader.js';
import { TIME_MS } from '../../lib/constants.js';
import {
  CODE_EVENT,
  CODE_EVENT_ATTR,
  CODE_QUALITY_CHECKPOINT_LIMIT,
  CODE_QUALITY_INVOCATION_LIMIT,
  CODE_QUALITY_LOOKBACK_DAYS,
  summarizeCodeQuality,
} from '../code-quality-summary.js';

export type {
  AgentVersionStats,
  AgentWindowStats,
  CodeQualityResponse,
  ContentKind,
  SurvivalCohort,
} from '../code-quality-summary.js';
import { handleRouteError } from '../route-errors.js';

/**
 * Dev-server route: a live query. Production never reaches this — the Worker
 * serves `/api/code-quality` from the KV key `scripts/sync-to-kv.ts` writes.
 */
export const codeQualityRoutes = new Hono();
codeQualityRoutes.onError(handleRouteError);

codeQualityRoutes.get('/code-quality', async (c) => {
  const now = new Date();
  const startIso = new Date(now.getTime() - CODE_QUALITY_LOOKBACK_DAYS * TIME_MS.DAY).toISOString();
  const endIso = now.toISOString();

  const [checkpointSpans, invocationSpans] = await Promise.all([
    loadTracesByFilter({ [CODE_EVENT_ATTR]: CODE_EVENT.CHECKPOINT }, startIso, endIso, CODE_QUALITY_CHECKPOINT_LIMIT),
    loadTracesByFilter({ [CODE_EVENT_ATTR]: CODE_EVENT.GENERATED }, startIso, endIso, CODE_QUALITY_INVOCATION_LIMIT),
  ]);
  return c.json(summarizeCodeQuality(checkpointSpans, invocationSpans));
});
