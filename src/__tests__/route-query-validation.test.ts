import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { blankAsAbsent, validQuery } from '../api/route-errors.js';
import { ErrorMessage, HttpStatus, PeriodSchema, RoleSchema } from '../lib/constants.js';

const HTTP_OK = 200;
const ProbeQuery = z.object({ period: PeriodSchema, role: blankAsAbsent(RoleSchema.optional()) });
const UnmappedQuery = z.object({ unmapped: z.string() });

const app = new Hono()
  .get('/probe', validQuery(ProbeQuery), (c) => c.json(c.req.valid('query')))
  .get('/unmapped', validQuery(UnmappedQuery), (c) => c.json(c.req.valid('query')));

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('route validQuery', () => {
  it('applies schema defaults when the query is empty', async () => {
    expect(await get('/probe')).toEqual({ status: HTTP_OK, body: { period: '7d' } });
  });

  it("answers 400 with the failing field's message", async () => {
    expect(await get('/probe?period=1y')).toEqual({
      status: HttpStatus.BadRequest,
      body: { error: ErrorMessage.InvalidPeriod },
    });
  });

  it('reads the first value of a repeated key', async () => {
    expect((await get('/probe?period=24h&period=1y')).body).toEqual({ period: '24h' });
  });

  it('treats an empty optional field as absent', async () => {
    expect(await get('/probe?role=')).toEqual({ status: HTTP_OK, body: { period: '7d' } });
  });

  it('falls back to the generic message for a field without one', async () => {
    expect((await get('/unmapped')).body).toEqual({ error: ErrorMessage.InvalidQuery });
  });
});
