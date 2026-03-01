import { Hono } from 'hono';
import { z } from 'zod';
import { sanitizeErrorForResponse } from '../../../../dist/lib/error-sanitizer.js';
import { HttpStatus } from '../../lib/constants.js';
import { loadEvaluationsByTraceId } from '../data-loader.js';

const TraceIdSchema = z.string().min(1).max(256);

export const evaluationRoutes = new Hono();

evaluationRoutes.get('/evaluations/trace/:traceId', async (c) => {
  const parseResult = TraceIdSchema.safeParse(c.req.param('traceId'));
  if (!parseResult.success) {
    return c.json({ error: 'Invalid traceId' }, HttpStatus.BadRequest);
  }

  try {
    const evaluations = await loadEvaluationsByTraceId(parseResult.data);
    return c.json({ evaluations });
  } catch (err) {
    return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
  }
});
