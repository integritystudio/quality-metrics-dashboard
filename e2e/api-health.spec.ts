import { test, expect } from '@playwright/test';

test.describe('API Endpoint Health', () => {
  test('GET /api/dashboard returns 200', async ({ request }) => {
    const res = await request.get('/api/dashboard?period=7d');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('metrics');
  });

  test('GET /api/dashboard with role returns 200', async ({ request }) => {
    const res = await request.get('/api/dashboard?period=7d&role=executive');
    expect(res.status()).toBe(200);
  });

  test('GET /api/metrics/:name returns 200 or 404', async ({ request }) => {
    const res = await request.get('/api/metrics/relevance?period=7d');
    expect([200, 404]).toContain(res.status());
  });

  test('GET /api/correlations returns 200', async ({ request }) => {
    const res = await request.get('/api/correlations?period=7d');
    expect(res.status()).toBe(200);
  });

  test('GET /api/coverage returns valid shape', async ({ request }) => {
    const res = await request.get('/api/coverage?period=7d');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('overallCoveragePercent');
  });

  test('GET /api/pipeline returns 200', async ({ request }) => {
    const res = await request.get('/api/pipeline?period=7d');
    expect(res.status()).toBe(200);
  });

  test('GET /api/compliance/sla returns 200', async ({ request }) => {
    const res = await request.get('/api/compliance/sla?period=7d');
    expect(res.status()).toBe(200);
  });

  test('GET /api/agents returns 200', async ({ request }) => {
    const res = await request.get('/api/agents?period=7d');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('agents');
  });

  test('GET /api/quality/live returns valid shape', async ({ request }) => {
    const res = await request.get('/api/quality/live');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('metrics');
    expect(body).toHaveProperty('sessionCount');
    expect(body).toHaveProperty('lastUpdated');
  });

  test('GET /api/trends/:name returns 200 or 404', async ({ request }) => {
    const res = await request.get('/api/trends/relevance?period=7d&buckets=5');
    expect([200, 404]).toContain(res.status());
  });

  test('rejects invalid period', async ({ request }) => {
    const res = await request.get('/api/dashboard?period=99d');
    expect(res.status()).toBe(400);
  });
});
