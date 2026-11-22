import type { Env, MiddlewareHandler } from 'hono';
import { createMiddleware } from 'hono/factory';
import { validator } from 'hono/validator';
import type { z } from 'zod';
import { HttpStatus } from './http-constants.js';

/**
 * Hono query validator shared by the Worker and the dev API server: answers 400 with the
 * failing field's message from `fieldErrors`, or `fallbackError` for a field it does not
 * name. A repeated key reads its first value, matching `c.req.query(name)`.
 *
 * No explicit return type: hono's `validator` returns a ~1500-character conditional type
 * that cannot be written by hand, and approximating it would erase the
 * `c.req.valid('query')` typing every route depends on.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- see the doc comment
export function queryValidator<T extends z.ZodType>(
  schema: T,
  fieldErrors: Readonly<Record<string, string>>,
  fallbackError: string,
) {
  return validator('query', (value, c) => {
    const firstValues = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]),
    );
    const result = schema.safeParse(firstValues);
    if (!result.success) {
      const field = String(result.error.issues[0]?.path[0] ?? '');
      return c.json({ error: fieldErrors[field] ?? fallbackError }, HttpStatus.BadRequest);
    }
    return result.data;
  });
}

/** Path-param guard shared by the Worker and the dev API server: answers 400 with `error` unless `pattern` matches. */
export function requireParam<E extends Env = Env>(name: string, pattern: RegExp, error: string): MiddlewareHandler<E> {
  return createMiddleware<E>(async (c, next) => {
    if (!pattern.test(c.req.param(name) ?? '')) return c.json({ error }, HttpStatus.BadRequest);
    return next();
  });
}
