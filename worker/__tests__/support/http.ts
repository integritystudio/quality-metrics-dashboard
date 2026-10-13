/** HTTP statuses the worker answers with and its upstreams are stubbed to return. */
export const HttpStatus = {
  Ok: 200,
  Created: 201,
  NoContent: 204,
  BadRequest: 400,
  Unauthorized: 401,
  Forbidden: 403,
  NotFound: 404,
  PayloadTooLarge: 413,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
} as const satisfies Record<string, number>;

export function jsonResponse(body: unknown, status: number = HttpStatus.Ok): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
