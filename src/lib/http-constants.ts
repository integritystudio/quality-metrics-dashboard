/**
 * HTTP statuses, header names and media types, spelled once for everything that
 * can reach `src/lib/` — frontend, the Hono API server and both test trees — so
 * a server and the code reading it cannot drift apart.
 *
 * `worker/index.ts` and `worker/__tests__/support/http.ts` keep their own copies.
 * That is convention, not necessity: this file imports nothing, and the worker
 * already reaches it through `postgrest-client.ts`. The boundary that stops the
 * worker importing `src/lib/constants.ts` does not apply here.
 */
export const HttpStatus = {
  Ok: 200,
  Created: 201,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  InternalServerError: 500,
  GatewayTimeout: 504,
} as const satisfies Record<string, number>;

/**
 * Lower-case on the wire. Node's `setHeader` sends the casing it is given, but
 * every reader is case-insensitive: `req.headers` arrives lower-cased and
 * `Response.headers.get` ignores case.
 */
export const CONTENT_TYPE_HEADER = 'content-type';

export const ContentType = {
  Json: 'application/json',
  Text: 'text/plain',
} as const satisfies Record<string, string>;
