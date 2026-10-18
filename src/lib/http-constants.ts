/**
 * HTTP statuses, header names and media types, spelled once for the whole
 * package — frontend, the Hono API server, the Worker, `scripts/` and every test
 * tree — so a server and the code reading it cannot drift apart.
 *
 * This module imports nothing, which is what lets the Worker use it: the
 * boundary that keeps `src/lib/constants.ts` and `src/api/api-constants.ts` out
 * of `worker/index.ts` is their dependencies, not their location.
 */
export const HttpStatus = {
  Ok: 200,
  Created: 201,
  NoContent: 204,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  PayloadTooLarge: 413,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
} as const satisfies Record<string, number>;

/**
 * Lower-case on the wire. Node's `setHeader` and `Response` send the casing they
 * are given, but every reader is case-insensitive: `req.headers` arrives
 * lower-cased, `Headers.get` ignores case, and so does a browser's CORS check.
 */
export const CONTENT_TYPE_HEADER = 'content-type';

export const ContentType = {
  Json: 'application/json',
  Ndjson: 'application/x-ndjson',
  Text: 'text/plain',
} as const satisfies Record<string, string>;
