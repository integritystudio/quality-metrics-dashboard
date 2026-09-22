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

// ── Wire-format row types ─────────────────────────────────────────────────────

/** Evaluation row as served by GET /v1/evaluations (snake_case). */
export interface EvalWireRow {
  org_id?: string;
  id?: number;
  timestamp_ns: string;
  evaluation_name: string;
  evaluator?: string;
  evaluator_type?: string;
  score_value?: number;
  score_label?: string;
  score_unit?: string;
  explanation?: string;
  error_type?: string | null;
  trace_id?: string;
  span_id?: string;
  session_id?: string;
  response_id?: string;
  agent_id?: string;
  agent_name?: string;
  trajectory_length?: number;
  service_name?: string;
  source?: string;
  attributes?: string;
  r2_key?: string;
  batch_index?: number;
}

/** Trace span row as served by GET /v1/traces (snake_case). */
export interface TraceWireRow {
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  name?: string;
  kind?: string;
  start_time_ns: string;
  end_time_ns?: string;
  status_code?: string;
  status_message?: string;
  service_name?: string;
  session_id?: string;
  attributes?: string;
  r2_key?: string;
}

/** Log record row as served by GET /v1/logs (snake_case). */
export interface LogWireRow {
  trace_id?: string;
  span_id?: string;
  timestamp_ns: string;
  severity_number?: number;
  severity_text?: string;
  body?: string;
  attributes?: string;
}

// ── Fixture server ────────────────────────────────────────────────────────────

export interface FixtureServer {
  /** Listening port. */
  readonly port: number;
  /** Base URL — set `process.env.OBTOOL_API_URL` to this value. */
  readonly url: string;
  /** Set evaluation rows returned by the next GET /v1/evaluations. */
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
  /** Clear rows and fail-paths. Call in beforeEach. */
  reset(): void;
  /** Shut down the server. Call in afterAll. */
  close(): Promise<void>;
}

function pagedBody<T>(rows: T[]): unknown {
  return { data: rows, count: rows.length, hasMore: false };
}

export async function createFixtureServer(): Promise<FixtureServer> {
  let evalRows: EvalWireRow[] = [];
  let traceRows: TraceWireRow[] = [];
  let logRows: LogWireRow[] = [];
  const failPaths = new Set<string>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const rawPath = req.url ?? '/';
    const path = rawPath.split('?')[0] ?? '/';

    for (const fp of failPaths) {
      if (path.startsWith(fp)) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'fixture failure' }));
        return;
      }
    }

    res.setHeader('Content-Type', 'application/json');

    if (path === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok' }));
    } else if (path === '/v1/evaluations') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(evalRows)));
    } else if (path === '/v1/traces') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(traceRows)));
    } else if (path === '/v1/logs') {
      res.writeHead(200);
      res.end(JSON.stringify(pagedBody(logRows)));
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
    reset() {
      evalRows = [];
      traceRows = [];
      logRows = [];
      failPaths.clear();
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
    timestamp_ns: String(e.timestamp ?? 1737000000000000000n),
    evaluation_name: e.evaluationName ?? 'relevance',
    evaluator: e.evaluator,
    evaluator_type: e.evaluatorType ?? 'seed',
    score_value: e.scoreValue ?? 0.85,
    score_label: e.scoreLabel,
    explanation: e.explanation,
    trace_id: e.traceId,
    span_id: e.spanId,
    session_id: e.sessionId,
    agent_name: e.agentName,
    trajectory_length: e.trajectoryLength,
    r2_key: FIXTURE_R2_KEY,
    batch_index: 0,
  };
}

/**
 * Convert a span-shaped object to the trace wire row that CloudBackend
 * serves and parses back to a `TraceSpan`.
 *
 * `attributes` is JSON-stringified; timestamps stay as decimal bigint strings.
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
  if (s.sessionId && !attrs['session.id']) attrs['session.id'] = s.sessionId;
  return {
    trace_id: s.traceId ?? 'trace-001',
    span_id: s.spanId ?? 'span-001',
    parent_span_id: s.parentSpanId ?? null,
    name: s.name ?? 'tool:unknown',
    kind: s.kind ?? 'INTERNAL',
    start_time_ns: String(s.startTimeUnixNano ?? 1737000000000000000n),
    end_time_ns: s.endTimeUnixNano !== undefined ? String(s.endTimeUnixNano) : undefined,
    status_code: s.status?.code ?? 'OK',
    status_message: s.status?.message,
    service_name: s.serviceName ?? 'claude-code',
    session_id: (attrs['session.id'] as string | undefined) ?? s.sessionId,
    attributes: JSON.stringify(attrs),
    r2_key: FIXTURE_R2_KEY,
  };
}

/**
 * Convert a loaded-log-shaped object to the log wire row that CloudBackend
 * parses back to a log record with an ISO timestamp string.
 */
export function logToWire(l: {
  timestamp?: string;
  severity?: string;
  body?: string;
  traceId?: string;
  attributes?: Record<string, unknown>;
}): LogWireRow {
  const ts = l.timestamp ?? '2026-01-01T00:00:00.000Z';
  const ms = BigInt(new Date(ts).getTime());
  return {
    trace_id: l.traceId,
    timestamp_ns: String(ms * NANOS_PER_MS),
    severity_text: l.severity ?? 'INFO',
    body: l.body,
    attributes: l.attributes ? JSON.stringify(l.attributes) : undefined,
  };
}
