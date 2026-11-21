import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startRecordingServer, inOrder, type RecordingServer } from './support/recording-server.js';
import { planShipment, sendPlan, toTurnContentRecord, type ShipmentPlan } from '../ship-turn-content.js';
import { turnFromRecord, turnsFromCloudRows } from '../judge-cloud-source.js';
import { turnContentSourceArg, DEFAULT_TURN_CONTENT_SOURCE } from '../pipeline-stages.js';
import { turnKey, type Turn } from '../judge-turns.js';
import { CliArgError } from '../cli-args.js';
import {
  TURNS_PATH,
  TURN_CONTENT_MAX_BATCH_SIZE,
  TURN_CONTENT_OPTED_OUT_CODE,
} from '../../../src/lib/core/obtool-contract.js';
import { MAX_SANITIZE_LENGTH } from '../../../src/lib/errors/error-sanitizer.js';
import { REDACTION_PLACEHOLDERS, REDACTION_RULESET_VERSION } from '../../../src/lib/privacy/content-redaction.js';
import { turnContentRecordSchema, type TurnContentRecord } from '../../../src/lib/validation/api-schemas.js';
import { HttpStatus } from '../../src/lib/http-constants.js';
import { defined } from '../../src/__tests__/support/defined.js';

const ACCOUNT = 'OBTOOL_API_KEY_SHIP_TEST';
const OTHER_ACCOUNT = 'OBTOOL_API_KEY_SHIP_OTHER';
const API_KEY = 'ship-test-key';
const OTHER_API_KEY = 'ship-other-key';
const SESSION_ID = '0a1b2c3d-1111-2222-3333-444455556666';
const TIMESTAMP = '2026-11-19T10:00:00.000Z';
const EMAIL = 'someone@example.com';

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    sessionId: SESSION_ID,
    traceId: '',
    timestamp: TIMESTAMP,
    userText: 'How do I configure the flush?',
    assistantText: 'Set the cron.',
    toolResults: ['config read'],
    identityKeyRef: ACCOUNT,
    spanId: '0123456789abcdef',
    ...overrides,
  };
}

const LAST_OFFSET_MS = 3;
const at = (i: number): string => new Date(Date.parse(TIMESTAMP) + i).toISOString();

/** The turn as anchoring leaves one no stamped span covers: no account at all. */
function unanchored({ identityKeyRef: _account, ...rest }: Turn): Turn {
  return rest;
}

function record(t: Turn): TurnContentRecord {
  const result = toTurnContentRecord(t);
  if (!('record' in result)) throw new Error(`expected a record, got ${result.withheld}`);
  return result.record;
}

describe('toTurnContentRecord', () => {
  it('redacts every text field and builds a record the ingest schema accepts', () => {
    const shipped = record(turn({ userText: `mail ${EMAIL}`, toolResults: [`owner: ${EMAIL}`] }));

    expect(shipped.userText).toBe(`mail ${REDACTION_PLACEHOLDERS.email}`);
    expect(shipped.toolContext).toEqual([`owner: ${REDACTION_PLACEHOLDERS.email}`]);
    expect(shipped.redaction).toEqual({ version: REDACTION_RULESET_VERSION, changed: true });
    expect(shipped.turnKey).toBe(turnKey(turn()));
    expect(turnContentRecordSchema.safeParse(shipped).success).toBe(true);
  });

  it('reports an untouched turn as unchanged and leaves out an empty trace id', () => {
    const shipped = record(turn());

    expect(shipped.redaction.changed).toBe(false);
    expect(shipped).not.toHaveProperty('traceId');
    expect(shipped.spanId).toBe('0123456789abcdef');
  });

  it('withholds a turn whose redaction was truncated', () => {
    expect(toTurnContentRecord(turn({ toolResults: [], userText: 'x'.repeat(MAX_SANITIZE_LENGTH + 1) })))
      .toEqual({ withheld: 'incomplete-redaction' });
  });
});

describe('planShipment', () => {
  const env = { [ACCOUNT]: API_KEY };

  it('sends a turn under its own account and skips one the cloud already holds', () => {
    const fresh = turn({ timestamp: at(1) });
    const shipped = turn({ timestamp: at(2) });

    const plan = planShipment([fresh, shipped], new Map([[ACCOUNT, new Set([turnKey(shipped)])]]), env);

    expect([...plan.byAccount.keys()]).toEqual([ACCOUNT]);
    expect(defined(plan.byAccount.get(ACCOUNT)).map((r) => r.turnKey)).toEqual([turnKey(fresh)]);
    expect(plan.inCloud).toBe(1);
  });

  it('never sends a turn without an account, and holds one whose key is not set here', () => {
    const plan = planShipment([
      unanchored(turn({ timestamp: at(1) })),
      turn({ identityKeyRef: null, timestamp: at(2) }),
      turn({ identityKeyRef: OTHER_ACCOUNT, timestamp: at(LAST_OFFSET_MS) }),
    ], new Map(), env);

    expect(plan.byAccount.size).toBe(0);
    expect(plan.withheld).toEqual({ 'no-account': 1, 'unmapped-account': 1 });
    expect(plan.heldForKey).toEqual({ [OTHER_ACCOUNT]: 1 });
  });
});

describe('sendPlan', () => {
  let ingest: RecordingServer;
  const env = { [ACCOUNT]: API_KEY, [OTHER_ACCOUNT]: OTHER_API_KEY };

  beforeAll(async () => { ingest = await startRecordingServer(); });
  afterAll(async () => ingest.close());
  beforeEach(() => ingest.reset());

  const planOf = (byAccount: Array<[string, Turn[]]>): ShipmentPlan => ({
    byAccount: new Map(byAccount.map(([ref, turns]) => [ref, turns.map((t) => record(t))])),
    discovered: 0, inCloud: 0, withheld: {}, heldForKey: {},
  });

  it('posts each account its own turns as NDJSON with its key, in batches of the contract size', async () => {
    const many = Array.from({ length: TURN_CONTENT_MAX_BATCH_SIZE + 1 }, (_, i) => turn({ timestamp: at(i) }));

    const summary = await sendPlan(planOf([[ACCOUNT, many], [OTHER_ACCOUNT, [turn()]]]), ingest.url, env);

    expect(summary).toEqual({ sent: many.length + 1, optedOut: [] });
    expect(ingest.requests.map((r) => [r.path, r.headers.authorization, r.body.trim().split('\n').length])).toEqual([
      [TURNS_PATH, `Bearer ${API_KEY}`, TURN_CONTENT_MAX_BATCH_SIZE],
      [TURNS_PATH, `Bearer ${API_KEY}`, 1],
      [TURNS_PATH, `Bearer ${OTHER_API_KEY}`, 1],
    ]);
    expect(ingest.requests[0]?.headers['content-type']).toBe('application/x-ndjson');
  });

  it('records an opted-out org and moves on to the next account without failing', async () => {
    ingest.respondWith(inOrder(
      { status: HttpStatus.Forbidden, body: JSON.stringify({ code: TURN_CONTENT_OPTED_OUT_CODE }) },
      { status: HttpStatus.Ok, body: '{}' },
    ));

    const summary = await sendPlan(planOf([[ACCOUNT, [turn()]], [OTHER_ACCOUNT, [turn()]]]), ingest.url, env);

    expect(summary).toEqual({ sent: 1, optedOut: [ACCOUNT] });
  });

  it('stops at a refused batch and says why', async () => {
    ingest.respondWith(() => ({ status: HttpStatus.BadRequest, body: '{"error":"Validation failed"}' }));

    const summary = await sendPlan(planOf([[ACCOUNT, [turn()]]]), ingest.url, env);

    expect(summary.sent).toBe(0);
    expect(summary.failure).toMatch(/400/);
  });
});

describe('turnsFromCloudRows', () => {
  it('rebuilds each turn once, leaving account and span to anchoring, and counts rows whose text is gone', () => {
    const shipped = record(turn({ traceId: 'trace-1', responseId: 'msg_1' }));
    const row = { turnKey: shipped.turnKey, sessionId: SESSION_ID, redactionVersion: REDACTION_RULESET_VERSION };

    const { turns, withoutContent } = turnsFromCloudRows([
      { ...row, content: shipped },
      { ...row, content: shipped },
      { ...row, turnKey: 'gone', content: null },
    ]);

    expect(turns).toEqual([turnFromRecord(shipped)]);
    expect(turns[0]).toEqual({
      sessionId: SESSION_ID, traceId: 'trace-1', timestamp: TIMESTAMP,
      userText: shipped.userText, assistantText: shipped.assistantText, toolResults: shipped.toolContext, responseId: 'msg_1',
    });
    expect(withoutContent).toBe(1);
  });
});

describe('turnContentSourceArg', () => {
  it('defaults to local and refuses an unknown source', () => {
    expect(turnContentSourceArg(undefined)).toBe(DEFAULT_TURN_CONTENT_SOURCE);
    expect(turnContentSourceArg('cloud')).toBe('cloud');
    expect(() => turnContentSourceArg('s3')).toThrow(CliArgError);
  });
});
