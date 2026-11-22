import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { WidePeriodQuery, blankAsAbsent, resolveMetric, validQuery } from '../api/route-errors.js';
import { PeriodSchema } from '../lib/constants.js';
import { DEFAULT_PERIOD_DETAIL, INVALID_PERIOD_MESSAGE } from '../lib/periods.js';
import {
  ERR_INVALID_INPUT_KEY,
  ERR_INVALID_METRIC_NAME,
  ERR_INVALID_PAGINATION,
  ERR_INVALID_QUERY,
  ERR_INVALID_ROLE,
  ERR_INVALID_SORT_BY,
  InputKeySchema,
  LimitSchema,
  OffsetSchema,
  SortBySchema,
} from '../lib/query-schemas.js';
import { RoleSchema } from '../lib/roles.js';
import { HttpStatus } from '../lib/http-constants.js';

const ProbeQuery = z.object({ period: PeriodSchema, role: blankAsAbsent(RoleSchema.optional()) });
const UnmappedQuery = z.object({ unmapped: z.string() });
const ListQuery = z.object({ limit: LimitSchema, offset: OffsetSchema, sortBy: SortBySchema, inputKey: InputKeySchema });

const app = new Hono()
  .get('/probe', validQuery(ProbeQuery), (c) => c.json(c.req.valid('query')))
  .get('/unmapped', validQuery(UnmappedQuery), (c) => c.json(c.req.valid('query')))
  .get('/list', validQuery(ListQuery), (c) => c.json(c.req.valid('query')))
  .get('/wide', validQuery(WidePeriodQuery), (c) => c.json(c.req.valid('query')))
  .get('/metric/:name', (c) => {
    const metric = resolveMetric(c, c.req.param('name'));
    return metric instanceof Response ? metric : c.json({ name: metric.name });
  });

async function get(path: string) {
  const res = await app.request(path);
  return { status: res.status, body: await res.json<Record<string, unknown>>() };
}

describe('route validQuery', () => {
  it('applies schema defaults when the query is empty', async () => {
    expect(await get('/probe')).toEqual({ status: HttpStatus.Ok, body: { period: '7d' } });
  });

  it("answers 400 with the failing field's message", async () => {
    expect(await get('/probe?period=1y')).toEqual({
      status: HttpStatus.BadRequest,
      body: { error: INVALID_PERIOD_MESSAGE },
    });
  });

  it('reads the first value of a repeated key', async () => {
    expect((await get('/probe?period=24h&period=1y')).body).toEqual({ period: '24h' });
  });

  it('treats an empty optional field as absent', async () => {
    expect(await get('/probe?role=')).toEqual({ status: HttpStatus.Ok, body: { period: '7d' } });
  });

  it('falls back to the generic message for a field without one', async () => {
    expect((await get('/unmapped')).body).toEqual({ error: ERR_INVALID_QUERY });
  });

  it.each([
    ['/probe?role=intern', ERR_INVALID_ROLE],
    ['/list?limit=0', ERR_INVALID_PAGINATION],
    ['/list?offset=-1', ERR_INVALID_PAGINATION],
    ['/list?sortBy=newest', ERR_INVALID_SORT_BY],
    ['/list?inputKey=spanId', ERR_INVALID_INPUT_KEY],
  ])("answers %s with the Worker's message", async (path, error) => {
    expect(await get(path)).toEqual({ status: HttpStatus.BadRequest, body: { error } });
  });

  it('defaults the wide-window views to the detail period', async () => {
    expect((await get('/wide')).body).toEqual({ period: DEFAULT_PERIOD_DETAIL });
  });

  it('rejects a metric name outside the shared id pattern', async () => {
    expect(await get('/metric/bad%20name')).toEqual({ status: HttpStatus.BadRequest, body: { error: ERR_INVALID_METRIC_NAME } });
  });

  it('accepts a one-character id, as the Worker does, and reports the metric unknown', async () => {
    expect((await get('/metric/x')).status).toBe(HttpStatus.NotFound);
  });
});
