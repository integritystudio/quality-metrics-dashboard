import { validator } from 'hono/validator';
import type { z } from 'zod';

const HTTP_BAD_REQUEST = 400;

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
      return c.json({ error: fieldErrors[field] ?? fallbackError }, HTTP_BAD_REQUEST);
    }
    return result.data;
  });
}
