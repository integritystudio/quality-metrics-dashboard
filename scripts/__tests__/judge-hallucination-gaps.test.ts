import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HALLUCINATION_GAP_EVENT,
  HALLUCINATION_GAP_SEVERITY,
  reportHallucinationGaps,
  toHallucinationGapLine,
  type HallucinationGapLine,
} from '../judge-hallucination-gaps.js';
import { HAIKU_MODEL } from '../judge-criteria.js';
import type { Turn } from '../judge-turns.js';
import { HALLUCINATION_EVAL_NAME } from '../../../src/lib/validation/dashboard-schemas.js';
import { severityCodec } from '../../../src/lib/otel/constants-otel.js';
import { makeTurn } from './support/fixtures.js';

const ACCOUNT_REF = 'OBTOOL_API_KEY_TEST';
const NOW = new Date('2026-11-22T06:30:00.000Z');
const MS_PER_SECOND = 1000;

const toolTurn = (overrides: Partial<Turn> = {}): Turn =>
  makeTurn({ toolResults: ['config.ts: export const PORT = 3001'], identityKeyRef: ACCOUNT_REF, ...overrides });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toHallucinationGapLine', () => {
  it('builds an ERROR log record the shipper can send under the turn\'s account', () => {
    const turn = toolTurn();
    const line = toHallucinationGapLine(turn, HAIKU_MODEL, NOW.getTime());
    expect(line).toMatchObject({
      severityText: HALLUCINATION_GAP_SEVERITY,
      severityNumber: severityCodec.encode(HALLUCINATION_GAP_SEVERITY),
      eventName: HALLUCINATION_GAP_EVENT,
      traceId: turn.traceId,
      identityKeyRef: ACCOUNT_REF,
    });
    expect(line?.timestamp).toEqual([NOW.getTime() / MS_PER_SECOND, 0]);
    expect(Object.values(line?.attributes ?? {})).toEqual(expect.arrayContaining([turn.sessionId, turn.timestamp, HALLUCINATION_EVAL_NAME, HAIKU_MODEL]));
  });

  it('builds none for a turn with no account', () => {
    expect(toHallucinationGapLine(makeTurn(), HAIKU_MODEL, NOW.getTime())).toBeUndefined();
  });
});

describe('reportHallucinationGaps', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hallucination-gaps-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('appends one line per shippable turn to the dated logs file and counts the rest', () => {
    const report = reportHallucinationGaps([toolTurn(), makeTurn()], HAIKU_MODEL, NOW, dir);
    expect(report).toEqual({ written: 1, unshipped: 1 });
    const [file] = readdirSync(dir);
    expect(file).toBe('logs-2026-11-22.jsonl');
    const lines = readFileSync(join(dir, file ?? ''), 'utf8').trim().split('\n').map(text => JSON.parse(text) as HallucinationGapLine);
    expect(lines.map(line => line.eventName)).toEqual([HALLUCINATION_GAP_EVENT]);
  });

  it('writes no file when there is no gap', () => {
    expect(reportHallucinationGaps([], HAIKU_MODEL, NOW, dir)).toEqual({ written: 0, unshipped: 0 });
    expect(readdirSync(dir)).toEqual([]);
  });
});
