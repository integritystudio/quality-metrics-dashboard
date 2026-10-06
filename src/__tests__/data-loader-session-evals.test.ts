/**
 * loadEvaluationsBySessionId reads one row past LIMIT_EVALS_SESSION, so a
 * session with more evaluations comes back flagged `truncated` instead of cut
 * off with no signal (DASHBOARD-SESSION-EVALS-CAP-SILENT).
 *
 * Fixture HTTP server, real CloudBackend. The backend slices what the server
 * returns to the `limit` the loader asked for, so serving one row more than the
 * cap only reaches the loader when the loader asked for that extra row.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createFixtureServer, evalToWire } from './support/fixture-server.js';
import type { FixtureServer } from './support/fixture-server.js';
import { makeEvaluation } from './support/fixtures.js';
import { LIMIT_EVALS_SESSION, loadEvaluationsBySessionId } from '../api/data-loader.js';

const SESSION_ID = 'sess-long';
const KEPT_ROW_NAME = 'relevance';
/** Names the row past the cap, so a test can tell which row was dropped. */
const OVERFLOW_ROW_NAME = 'past-the-cap';

let fixture: FixtureServer;

beforeAll(async () => {
  fixture = await createFixtureServer();
  process.env.OBTOOL_API_URL = fixture.url;
});

afterAll(async () => {
  delete process.env.OBTOOL_API_URL;
  await fixture.close();
});

beforeEach(() => {
  fixture.reset();
});

/** Serve `count` evaluations for the session; rows past the cap carry {@link OVERFLOW_ROW_NAME}. */
function serveSessionEvaluations(count: number) {
  fixture.setEvals(Array.from({ length: count }, (_, index) => evalToWire(
    makeEvaluation({
      sessionId: SESSION_ID,
      evaluationName: index < LIMIT_EVALS_SESSION ? KEPT_ROW_NAME : OVERFLOW_ROW_NAME,
    }),
    index + 1,
  )));
}

describe('loadEvaluationsBySessionId', () => {
  it.each([
    ['one fewer than the limit', LIMIT_EVALS_SESSION - 1],
    ['exactly the limit', LIMIT_EVALS_SESSION],
  ])('returns every row, not truncated, for %s', async (_case, count) => {
    serveSessionEvaluations(count);

    const result = await loadEvaluationsBySessionId(SESSION_ID);

    expect(result.truncated).toBe(false);
    expect(result.evaluations).toHaveLength(count);
  });

  it('flags one more than the limit as truncated and returns only the limit', async () => {
    serveSessionEvaluations(LIMIT_EVALS_SESSION + 1);

    const result = await loadEvaluationsBySessionId(SESSION_ID);

    expect(result.truncated).toBe(true);
    expect(result.evaluations).toHaveLength(LIMIT_EVALS_SESSION);
    expect(result.evaluations.some(e => e.evaluationName === OVERFLOW_ROW_NAME)).toBe(false);
  });
});
