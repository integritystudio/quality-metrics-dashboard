import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { CalibrationState } from '@parent/lib/quality/qfe-percentiles.js';
import { MIN_QUANTILE_SAMPLE_SIZE } from '@parent/lib/quality/qfe-label-ordinals.js';
import type { CalibrationResponse } from '../../src/lib/validation/dashboard-schemas.js';

/**
 * The store's location hangs off HOME and is fixed when judge-evaluations.ts is
 * imported, so every test here runs under a temp HOME: it is stubbed first and
 * the scripts are imported afterwards, dynamically. Never import them
 * statically in this file — the tests would read and write the real telemetry
 * directory.
 */
let home: string;
let telemetryDir: string;
let store: typeof import('../calibration-store.js');
let derive: typeof import('../derive-evaluations.js');
let sync: typeof import('../sync-to-kv.js');
let warn: MockInstance<typeof console.warn>;

const METRIC = 'tool_correctness';
const STORE_MODULE = 'calibration-store.ts';

/** The sync run's clock. The bound is 30 days, so the two stamps below sit on either side of it. */
const NOW = new Date('2026-10-05T12:00:00.000Z');
const CALIBRATED_AT_THE_BOUND = '2026-09-05T12:00:00.000Z';
const CALIBRATED_PAST_THE_BOUND = '2026-09-05T11:59:59.999Z';

function stateCalibratedAt(lastCalibrated: string): CalibrationState {
  return {
    lastCalibrated,
    distributions: {
      [METRIC]: {
        distribution: { p10: 0.1, p25: 0.25, p50: 0.5, p75: 0.75, p90: 0.9 },
        sampleSize: MIN_QUANTILE_SAMPLE_SIZE,
        windowStart: '2026-08-06T12:00:00.000Z',
        windowEnd: lastCalibrated,
      },
    },
  };
}

function publishedPayload(entry: { value: string } | null): CalibrationResponse {
  if (!entry) throw new Error('expected sync to publish a meta:calibration entry');
  return JSON.parse(entry.value) as CalibrationResponse;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'calibration-store-'));
  vi.stubEnv('HOME', home);
  vi.resetModules();
  const judge = await import('../judge-evaluations.js');
  if (!judge.TELEMETRY_DIR.startsWith(home)) {
    throw new Error(`refusing to run: the calibration store resolves to ${judge.TELEMETRY_DIR}, outside the temp HOME`);
  }
  telemetryDir = judge.TELEMETRY_DIR;
  store = await import('../calibration-store.js');
  derive = await import('../derive-evaluations.js');
  sync = await import('../sync-to-kv.js');
});

beforeEach(() => {
  rmSync(telemetryDir, { recursive: true, force: true });
  mkdirSync(telemetryDir, { recursive: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('calibration handoff from derive to sync', () => {
  it('sync publishes the state derive wrote', () => {
    const writtenAt = new Date('2026-10-05T06:00:00.000Z');
    const records = Array.from({ length: MIN_QUANTILE_SAMPLE_SIZE }, (_, i) => ({
      evaluationName: METRIC,
      scoreValue: i / (MIN_QUANTILE_SAMPLE_SIZE - 1),
    }));

    derive.recalibrate(records, { dryRun: false, now: writtenAt });
    const payload = publishedPayload(sync.homeCalibrationEntry(NOW));

    expect(payload.lastCalibrated).toBe(writtenAt.toISOString());
    expect(payload.sampleCounts).toEqual({ [METRIC]: MIN_QUANTILE_SAMPLE_SIZE });
    expect(warn).not.toHaveBeenCalled();
  });

  it('no script but the store reads or writes calibration state directly', () => {
    const scriptsDir = resolve(__dirname, '..');

    const bypassing = readdirSync(scriptsDir)
      .filter(file => file.endsWith('.ts') && file !== STORE_MODULE)
      .filter(file => /\b(?:load|save)CalibrationState\b/.test(readFileSync(join(scriptsDir, file), 'utf8')));

    expect(bypassing).toEqual([]);
  });
});

describe('homeCalibrationEntry', () => {
  it('warns, naming where it looked, and publishes nothing when derive has written no state', () => {
    const entry = sync.homeCalibrationEntry(NOW);

    expect(entry).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(telemetryDir);
  });

  it('warns about a state older than the bound and still publishes it', () => {
    store.writeCalibrationState(stateCalibratedAt(CALIBRATED_PAST_THE_BOUND));

    const payload = publishedPayload(sync.homeCalibrationEntry(NOW));

    expect(payload.lastCalibrated).toBe(CALIBRATED_PAST_THE_BOUND);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain(CALIBRATED_PAST_THE_BOUND);
  });
});

describe('calibrationStalenessWarning', () => {
  it('is silent for a state exactly as old as the bound', () => {
    const warning = store.calibrationStalenessWarning(stateCalibratedAt(CALIBRATED_AT_THE_BOUND), NOW.getTime());

    expect(warning).toBeNull();
  });

  it('warns one millisecond past the bound', () => {
    const warning = store.calibrationStalenessWarning(stateCalibratedAt(CALIBRATED_PAST_THE_BOUND), NOW.getTime());

    expect(warning).toContain(CALIBRATED_PAST_THE_BOUND);
  });

  it('warns when there is no state', () => {
    const warning = store.calibrationStalenessWarning(null, NOW.getTime());

    expect(warning).toContain(telemetryDir);
  });

  it('warns when lastCalibrated is not a date', () => {
    const warning = store.calibrationStalenessWarning(stateCalibratedAt('not-a-date'), NOW.getTime());

    expect(warning).toContain('not-a-date');
  });
});
