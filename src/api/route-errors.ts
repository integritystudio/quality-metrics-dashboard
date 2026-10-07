import type { Context } from 'hono';
import type { z } from 'zod';
import { sanitizeErrorForResponse } from './parent/error-sanitizer.js';
import { HttpStatus } from '../lib/constants.js';

/** A rejected request parameter; `handleRouteError` answers it with 400 and the message. */
export class BadRequestError extends Error {}

/** Parses one request parameter, or throws `BadRequestError` with `message`. */
export function parseParam<T extends z.ZodType>(schema: T, value: unknown, message: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(message);
  return result.data;
}

/** Every route app's `onError`: a parameter error is 400, anything else a sanitized 500. */
export function handleRouteError(err: Error, c: Context): Response {
  if (err instanceof BadRequestError) return c.json({ error: err.message }, HttpStatus.BadRequest);
  return c.json({ error: sanitizeErrorForResponse(err) }, HttpStatus.InternalServerError);
}
