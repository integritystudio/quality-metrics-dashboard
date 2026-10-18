/**
 * Statuses, header names and media types the local test servers answer with,
 * spelled once so `fixture-server` and `recording-server` cannot drift: one had
 * named them privately while the other wrote the same values inline.
 *
 * The status names match `worker/index.ts`'s own `Http` object, which the
 * worker keeps local because it cannot safely import this package's constants.
 */
export const Http = {
  Ok: 200,
  BadRequest: 400,
  NotFound: 404,
  InternalServerError: 500,
} as const satisfies Record<string, number>;

/** Lower-case, as Node and fetch normalize it either way. */
export const CONTENT_TYPE_HEADER = 'content-type';

export const ContentType = {
  Json: 'application/json',
  Text: 'text/plain',
} as const satisfies Record<string, string>;
