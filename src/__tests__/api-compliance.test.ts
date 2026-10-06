/**
 * API route tests: /api/compliance/sla and /api/compliance/verifications.
 *
 * Approach C — fixture HTTP server for the evaluations path (SLA), with the
 * parent's real computeDashboardSummary. Verifications are read by the
 * parent's real queryVerifications from JSONL files in a temp TELEMETRY_DIR.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';

// The parent caches TELEMETRY_DIR on first read, and the shell's value is the
// developer's real telemetry; point it at a temp dir before anything imports.
const { telemetryDir, previousTelemetryDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previous = process.env.TELEMETRY_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'compliance-telemetry-'));
  process.env.TELEMETRY_DIR = dir;
  return { telemetryDir: dir, previousTelemetryDir: previous };
});

import { complianceRoutes } from '../api/routes/compliance.js';
import type { SlaComplianceResponse, VerificationsResponse } from './support/api-responses.js';
import type { HumanVerificationEvent } from '../types.js';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

const VERIFICATIONS_SUBDIR = 'verifications';
const JSONL_SUFFIX = '.jsonl';
const ONE_HOUR_MS = 3_600_000;

const verificationsDir = join(telemetryDir, VERIFICATIONS_SUBDIR);

/** The day file queryVerifications reads for `iso`, named by its UTC date. */
function dayFile(iso: string): string {
  return join(verificationsDir, `${iso.slice(0, 10)}${JSONL_SUFFIX}`);
}

function makeVerification(sessionId: string): HumanVerificationEvent {
  return {
    timestamp: new Date(Date.now() - ONE_HOUR_MS).toISOString(),
    sessionId,
    verificationType: 'approval',
  };
}

function writeVerifications(events: HumanVerificationEvent[]): void {
  mkdirSync(verificationsDir, { recursive: true });
  for (const event of events) {
    writeFileSync(dayFile(event.timestamp), `${JSON.stringify(event)}\n`, { flag: 'a' });
  }
}

beforeEach(() => {
  fixture.reset();
  rmSync(verificationsDir, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(telemetryDir, { recursive: true, force: true });
  if (previousTelemetryDir === undefined) delete process.env.TELEMETRY_DIR;
  else process.env.TELEMETRY_DIR = previousTelemetryDir;
});

// /compliance/sla

describe('GET /compliance/sla', () => {
  it('rejects invalid period with 400', async () => {
    const res = await complianceRoutes.request('/compliance/sla?period=99d');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period, results, noSLAsConfigured', async () => {
    const res = await complianceRoutes.request('/compliance/sla?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as SlaComplianceResponse;
    expect(body).toEqual({ period: '7d', results: [], noSLAsConfigured: true });
  });

  it('returns 500 when data-loader throws', async () => {
    fixture.failPath('/v1/evaluations');
    const res = await complianceRoutes.request('/compliance/sla?period=7d');
    expect(res.status).toBe(500);
  });
});

// /compliance/verifications

describe('GET /compliance/verifications', () => {
  it('rejects invalid period with 400', async () => {
    const res = await complianceRoutes.request('/compliance/verifications?period=bad');
    expect(res.status).toBe(400);
  });

  it('returns 200 with period, count, verifications', async () => {
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    expect(res.status).toBe(200);
    const body = await res.json() as VerificationsResponse;
    expect(body).toEqual({ period: '7d', count: 0, verifications: [] });
  });

  it('returns the verifications recorded in the period', async () => {
    writeVerifications([makeVerification('sess-1'), makeVerification('sess-2')]);
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    const body = await res.json() as VerificationsResponse;
    expect(body.count).toBe(2);
    expect(body.verifications.map((v) => v.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
  });

  it('returns 500 when a verification file cannot be read', async () => {
    // A directory where the day's JSONL file should be: listed, then unreadable.
    mkdirSync(dayFile(new Date().toISOString()), { recursive: true });
    const res = await complianceRoutes.request('/compliance/verifications?period=7d');
    expect(res.status).toBe(500);
  });
});
