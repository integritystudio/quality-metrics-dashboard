import { CONTENT_TYPE_HEADER, ContentType, HttpStatus } from '../../../src/lib/http-constants.js';

export function jsonResponse(body: unknown, status: number = HttpStatus.Ok): Response {
  return new Response(JSON.stringify(body), { status, headers: { [CONTENT_TYPE_HEADER]: ContentType.Json } });
}
