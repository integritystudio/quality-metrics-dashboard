import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { CalibrationState } from '@parent/lib/quality/qfe-percentiles.js';
import { MIN_QUANTILE_SAMPLE_SIZE } from '@parent/lib/quality/qfe-label-ordinals.js';
import { CALIBRATION_STATE_FILE } from '@parent/lib/quality/quality-constants.js';
import type { CalibrationResponse } from '../../src/lib/validation/dashboard-schemas.js';
import { createFixtureServer, type FixtureServer } from '../../src/__tests__/support/fixture-server.js';

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
let cloud: typeof import('../../../src/backends/cloud.js');
let argv: string[];
let warn: MockInstance<typeof console.warn>;
let log: MockInstance<typeof console.log>;

const METRIC = 'tool_correctness';
const STORE_MODULE = 'calibration-store.ts';
/** The key sync-to-kv publishes the calibration under; the worker serves it by this name. */
const CALIBRATION_KEY = 'meta:calibration';
/**
 * sync-to-kv reads its flags at import. Its degradation pass keeps a sidecar
 * in scripts/ itself, not under HOME, and this flag is what stops it writing
 * there when `computeOrgEntries` runs below.
 */
const SYNC_DRY_RUN_ARG = '--dry-run';

/** The sync run's clock. The bound is 30 days, so the two stamps below sit on either side of it. */
const NOW = new Date('2026-10-05T12:00:00.000Z');
const CALIBRATED_AT_THE_BOUND = '2026-09-05T12:00:00.000Z';
const CALIBRATED_PAST_THE_BOUND = '2026-09-05T11:59:59.999Z';
/** The derive run's clock, earlier the same day; the evening run follows it. */
const WRITTEN_AT = new Date('2026-10-05T06:00:00.000Z');
const LATER_RUN = new Date('2026-10-05T18:00:00.000Z');

/** Enough scores for derive to calibrate one metric. */
function calibrationRecords(): { evaluationName: string; scoreValue: number }[] {
  return Array.from({ length: MIN_QUANTILE_SAMPLE_SIZE }, (_, i) => ({
    evaluationName: METRIC,
    scoreValue: i / (MIN_QUANTILE_SAMPLE_SIZE - 1),
  }));
}

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
  argv = process.argv;
  process.argv = [...argv, SYNC_DRY_RUN_ARG];
  vi.resetModules();
  const judge = await import('../judge-evaluations.js');
  if (!judge.TELEMETRY_DIR.startsWith(home)) {
    throw new Error(`refusing to run: the calibration store resolves to ${judge.TELEMETRY_DIR}, outside the temp HOME`);
  }
  telemetryDir = judge.TELEMETRY_DIR;
  store = await import('../calibration-store.js');
  derive = await import('../derive-evaluations.js');
  sync = await import('../sync-to-kv.js');
  cloud = await import('../../../src/backends/cloud.js');
});

beforeEach(() => {
  rmSync(telemetryDir, { recursive: true, force: true });
  mkdirSync(telemetryDir, { recursive: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  log.mockRestore();
});

afterAll(() => {
  vi.unstubAllEnvs();
  process.argv = argv;
  rmSync(home, { recursive: true, force: true });
});

describe('calibration handoff from derive to sync', () => {
  it('sync publishes the state derive wrote', () => {
    derive.recalibrate(calibrationRecords(), { dryRun: false, now: WRITTEN_AT });
    const payload = publishedPayload(sync.homeCalibrationEntry(NOW));

    expect(payload.lastCalibrated).toBe(WRITTEN_AT.toISOString());
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

describe('recalibrate', () => {
  it('writes nothing on a dry run, and says what it would have written', () => {
    derive.recalibrate(calibrationRecords(), { dryRun: true, now: WRITTEN_AT });

    expect(readdirSync(telemetryDir)).toEqual([]);
    expect(store.readCalibrationState()).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(CALIBRATION_STATE_FILE));
  });

  // The staleness bound is sized around this: a stamp that stays put is what a
  // stable distribution looks like, not a derive that stopped writing.
  it('leaves lastCalibrated at the earlier run when the distribution has not drifted', () => {
    const records = calibrationRecords();
    derive.recalibrate(records, { dryRun: false, now: WRITTEN_AT });

    derive.recalibrate(records, { dryRun: false, now: LATER_RUN });

    expect(store.readCalibrationState()?.lastCalibrated).toBe(WRITTEN_AT.toISOString());
  });
});

/**
 * The call site that was the bug: sync computed every org's entries and asked
 * the wrong directory for the calibration, so `meta:calibration` was simply
 * absent from the home org's list while every run reported success. Reads an
 * empty cloud through the real backend; the calibration is derive's file, not
 * the cloud's data.
 */
describe('computeOrgEntries', () => {
  let fixture: FixtureServer;
  let backend: InstanceType<typeof cloud.CloudBackend>;
  const scriptsDir = resolve(__dirname, '..');

  beforeAll(async () => {
    fixture = await createFixtureServer();
    backend = new cloud.CloudBackend({ baseUrl: fixture.url });
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('publishes the calibration derive wrote among the home org entries, and writes nothing into scripts/', async () => {
    derive.recalibrate(calibrationRecords(), { dryRun: false, now: WRITTEN_AT });
    const scriptsBefore = readdirSync(scriptsDir);

    const { allEntries } = await sync.computeOrgEntries(backend, NOW, true);

    const entry = allEntries.find(e => e.key === CALIBRATION_KEY) ?? null;
    expect(publishedPayload(entry).lastCalibrated).toBe(WRITTEN_AT.toISOString());
    expect(readdirSync(scriptsDir)).toEqual(scriptsBefore);
  });

  it('publishes no calibration entry for an org that is not the home org', async () => {
    derive.recalibrate(calibrationRecords(), { dryRun: false, now: WRITTEN_AT });

    const { allEntries } = await sync.computeOrgEntries(backend, NOW, false);

    expect(allEntries.map(e => e.key)).not.toContain(CALIBRATION_KEY);
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
