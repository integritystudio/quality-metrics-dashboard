/**
 * Local HTTP fixture server for route tests (ROUTE-TESTS-MOCK-FREE).
 *
 * Serves canned wire-format payloads to CloudBackend, exercising the real
 * route → data-loader → CloudBackend → HTTP path end-to-end without hitting
 * the production API.
 *
 * Typical usage:
 *   let fixture: FixtureServer;
 *   beforeAll(async () => {
 *     fixture = await createFixtureServer();
 *     process.env.OBTOOL_API_URL = fixture.url;
 *   });
 *   afterAll(async () => {
 *     delete process.env.OBTOOL_API_URL;
 *     await fixture.close();
 *   });
 *   beforeEach(() => fixture.reset());
 *   // Per-test:
 *   fixture.setEvals([evalToWire(makeEvaluation())]);
 *   fixture.setTraces([spanToWire(makeSpan())]);
 *   fixture.failPath('/v1/evaluations'); // triggers 500 for error-path tests
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { EvaluationRow, LogRow, TraceSpan } from '@obtool-api/types';
import { SESSION_ATTRIBUTES } from '../../lib/otel-attributes.js';

// ── Wire-format row types ─────────────────────────────────────────────────────
// Typed off obtool-api's own response rows (type-only import, erased at runtime),
// so a column the API adds or retypes fails typecheck here instead of surfacing
// as a 500 when CloudBackend's schema rejects the canned payload.

/** Evaluation row as served by GET /v1/evaluations (snake_case). */
export type EvalWireRow = EvaluationRow;

/**
 * Trace span row as served by GET /v1/traces (snake_case). `kind` and
 * `status_code` also accept the enum names CloudBackend still decodes from rows
 * flushed before ingest normalized them to ints.
 */
export type TraceWireRow = Omit<TraceSpan, 'kind' | 'status_code'> & {
  kind: TraceSpan['kind'] | string;
  status_code: TraceSpan['status_code'] | string;
};

/** Log record row as served by GET /v1/logs (snake_case). */
export type LogWireRow = LogRow;

// ── Fixture server ────────────────────────────────────────────────────────────

export interface FixtureServer {
  /** Listening port. */
  readonly port: number;
  /** Base URL — set `process.env.OBTOOL_API_URL` to this value. */
  readonly url: string;
  /** Set evaluation rows returned by GET /v1/evaluations, narrowed by its `evaluationName` and `traceId` params. */
  setEvals(rows: EvalWireRow[]): void;
  /** Set trace span rows returned by the next GET /v1/traces. */
  setTraces(rows: TraceWireRow[]): void;
  /** Set log rows returned by the next GET /v1/logs. */
  setLogs(rows: LogWireRow[]): void;
  /**
   * Make every request whose path starts with `prefix` return HTTP 500.
   * Used for error-path tests that need a collaborator to fail.
   */
  failPath(prefix: string): void;
  /**
   * Make requests to `path` whose query has `param=value` return HTTP 500, for
   * error paths where one of several parallel reads must fail.
   */
  failQuery(path: string, param: string, value: string): void;
  /**
   * Paths requested since the last reset, query strings stripped. For reads a
   * caller swallows on failure, where `failPath` cannot show they were skipped.
   */
  requestedPaths(): string[];
  /** Requests since the last reset, with their query strings. */
  requests(): FixtureRequest[];
  /** Clear rows, fail-paths and requested paths. Call in beforeEach. */
  reset(): void;
  /** Shut down the server. Call in afterAll. */
  close(): Promise<void>;
}

/** GET /v1/evaluations query params the fixture applies, as obtool-api does. */
const EVALUATION_NAME_PARAM = 'evaluationName';
const TRACE_ID_PARAM = 'traceId';

/** `evaluationName` case-insensitively (obtool-api's SQL LIKE); `traceId` exactly. */
function filterEvals(rows: EvalWireRow[], query: URLSearchParams): EvalWireRow[] {
  const name = query.get(EVALUATION_NAME_PARAM)?.toLowerCase();
  const traceId = query.get(TRACE_ID_PARAM);
  return rows.filter((row) =>
    (!name || row.evaluation_name.toLowerCase() === name)
    && (!traceId || row.trace_id === traceId));
}

/** A request the fixture received: its path and parsed query string. */
export interface FixtureRequest {
  path: string;
  query: URLSearchParams;
}

/**
 * Cursor encoding: a decimal offset into the row set, held as a plain decimal
 * string (e.g. `"1000"`). Simple enough for the fixture; decodes without Base64
 * so tests can read the query string directly.
 */
const CURSOR_RADIX = 10;

function pagedBody<T>(rows: T[], query?: URLSearchParams): unknown {
  const limitStr = query?.get('limit');
  const cursorStr = query?.get('cursor');

  const limit = limitStr ? parseInt(limitStr, CURSOR_RADIX) : undefined;
  const offset = cursorStr ? (parseInt(cursorStr, CURSOR_RADIX) || 0) : 0;

  const validLimit = limit !== undefined && !isNaN(limit) && limit > 0 ? limit : undefined;
  const pageEnd = validLimit !== undefined ? offset + validLimit : rows.length;
  const pageRows = rows.slice(offset, pageEnd);
  const hasMore = pageEnd < rows.length;
  const nextCursor = hasMore ? String(pageEnd) : undefined;

  return {
    data: pageRows,
    count: pageRows.length,
    hasMore,
    ...(nextCursor !== undefined && { nextCursor }),
  };
}

export async function createFixtureServer(): Promise<FixtureServer> {
  let evalRows: EvalWireRow[] = [];
  let traceRows: TraceWireRow[] = [];
  let logRows: LogWireRow[] = [];
  const failPaths = new Set<string>();
  let failQueries: { path: string; param: string; value: string }[] = [];
  let requested: FixtureRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = req.url ?? '/';
    const path = rawPath.split('?')[0] ?? '/';
    const query = new URLSearchParams(rawPath.slice(path.length + 1));
    requested.push({ path, query });

    const failed = [...failPaths].some((fp) => path.startsWith(fp))
      || failQueries.some((fq) => fq.path === path && query.get(fq.param) === fq.value);
    if (failed) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fixture failure' }));
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    if (path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (path === '/v1/evaluations') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(filterEvals(evalRows, query), query)));
    } else if (path === '/v1/traces') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(traceRows, query)));
    } else if (path === '/v1/logs') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(logRows, query)));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    get port() { return port; },
    get url() { return baseUrl; },
    setEvals(rows) { evalRows = rows; },
    setTraces(rows) { traceRows = rows; },
    setLogs(rows) { logRows = rows; },
    failPath(prefix) { failPaths.add(prefix); },
    failQuery(path, param, value) { failQueries.push({ path, param, value }); },
    requestedPaths() { return requested.map((r) => r.path); },
    requests() { return [...requested]; },
    reset() {
      evalRows = [];
      traceRows = [];
      logRows = [];
      failPaths.clear();
      failQueries = [];
      requested = [];
    },
    close() {
      return new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

// ── Conversion helpers ────────────────────────────────────────────────────────

const NANOS_PER_MS = 1_000_000n;
const FIXTURE_ORG_ID = 'test-org';
const FIXTURE_R2_KEY = 'fixture/r2/key';
const FIXTURE_SERVICE_NAME = 'claude-code';
const FIXTURE_EVAL_SOURCE = 'fixture';
const FIXTURE_TIMESTAMP_NS = 1737000000000000000n;
const FIXTURE_LOG_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const FIXTURE_LOG_SEVERITY = 'INFO';
/** OTLP SeverityNumber for INFO. */
const FIXTURE_LOG_SEVERITY_NUMBER = 9;
const EMPTY_ATTRIBUTES = '{}';
/** obtool-api serves '' (never null) for absent evaluation trace/span/session ids — migration 0006. */
const ABSENT_EVAL_ID = '';

/**
 * Convert an `EvaluationResult`-shaped object to the wire row that
 * CloudBackend serves and parses back to `EvaluationResult`.
 */
export function evalToWire(
  e: {
    evaluationName?: string;
    scoreValue?: number;
    timestamp?: bigint;
    traceId?: string;
    spanId?: string;
    sessionId?: string;
    evaluator?: string;
    evaluatorType?: string;
    scoreLabel?: string;
    explanation?: string;
    agentName?: string;
    trajectoryLength?: number;
  },
  id = 1,
): EvalWireRow {
  return {
    org_id: FIXTURE_ORG_ID,
    id,
    timestamp_ns: String(e.timestamp ?? FIXTURE_TIMESTAMP_NS),
    evaluation_name: e.evaluationName ?? 'relevance',
    evaluator: e.evaluator ?? ABSENT_EVAL_ID,
    evaluator_type: e.evaluatorType ?? 'seed',
    score_value: e.scoreValue ?? 0.85,
    score_label: e.scoreLabel ?? null,
    score_unit: null,
    explanation: e.explanation ?? null,
    error_type: null,
    judge_model: null,
    trace_id: e.traceId ?? ABSENT_EVAL_ID,
    span_id: e.spanId ?? ABSENT_EVAL_ID,
    session_id: e.sessionId ?? ABSENT_EVAL_ID,
    response_id: null,
    agent_id: null,
    agent_name: e.agentName ?? null,
    trajectory_length: e.trajectoryLength ?? null,
    service_name: null,
    source: FIXTURE_EVAL_SOURCE,
    attributes: EMPTY_ATTRIBUTES,
    r2_key: FIXTURE_R2_KEY,
    batch_index: 0,
  };
}

/**
 * Convert a span-shaped object to the trace wire row that CloudBackend
 * serves and parses back to a `TraceSpan`.
 *
 * `attributes` is JSON-stringified; timestamps stay as decimal bigint strings.
 * An absent end time is served as the start time (zero duration).
 */
export function spanToWire(s: {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string | null;
  name?: string;
  kind?: string;
  startTimeUnixNano?: bigint;
  endTimeUnixNano?: bigint;
  status?: { code?: string; message?: string };
  attributes?: Record<string, unknown>;
  sessionId?: string;
  serviceName?: string;
}): TraceWireRow {
  const attrs = { ...(s.attributes ?? {}) };
  if (s.sessionId && !attrs[SESSION_ATTRIBUTES.ID]) attrs[SESSION_ATTRIBUTES.ID] = s.sessionId;
  const start = s.startTimeUnixNano ?? FIXTURE_TIMESTAMP_NS;
  return {
    org_id: FIXTURE_ORG_ID,
    trace_id: s.traceId ?? 'trace-001',
    span_id: s.spanId ?? 'span-001',
    parent_span_id: s.parentSpanId ?? null,
    name: s.name ?? 'tool:unknown',
    kind: s.kind ?? 'INTERNAL',
    start_time_ns: String(start),
    end_time_ns: String(s.endTimeUnixNano ?? start),
    status_code: s.status?.code ?? 'OK',
    status_message: s.status?.message ?? null,
    service_name: s.serviceName ?? FIXTURE_SERVICE_NAME,
    session_id: (attrs[SESSION_ATTRIBUTES.ID] as string | undefined) ?? s.sessionId ?? null,
    attributes: JSON.stringify(attrs),
    r2_key: FIXTURE_R2_KEY,
  };
}

/**
 * Convert a loaded-log-shaped object to the log wire row that CloudBackend
 * parses back to a log record with an ISO timestamp string.
 */
export function logToWire(
  l: {
    timestamp?: string;
    severity?: string;
    body?: string;
    traceId?: string;
    attributes?: Record<string, unknown>;
  },
  id = 1,
): LogWireRow {
  const ts = l.timestamp ?? FIXTURE_LOG_TIMESTAMP;
  const ms = BigInt(new Date(ts).getTime());
  return {
    org_id: FIXTURE_ORG_ID,
    id,
    timestamp_ns: String(ms * NANOS_PER_MS),
    severity_number: FIXTURE_LOG_SEVERITY_NUMBER,
    severity_text: l.severity ?? FIXTURE_LOG_SEVERITY,
    body_preview: l.body ?? null,
    trace_id: l.traceId ?? null,
    span_id: null,
    service_name: FIXTURE_SERVICE_NAME,
    session_id: null,
    event_name: null,
    attributes: l.attributes ? JSON.stringify(l.attributes) : EMPTY_ATTRIBUTES,
    r2_key: FIXTURE_R2_KEY,
  };
}
