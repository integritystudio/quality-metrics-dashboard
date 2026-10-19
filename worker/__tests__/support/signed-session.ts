/**
 * The JWT-path auth harness: one test issuer per file signing a token for `sub`, and a
 * `fetchMock` behind its JWKS that stands in for global `fetch`, reset before each test.
 */
import { afterEach, beforeAll, beforeEach, vi, type Mock } from 'vitest';
import { TEST_AUTH0_DOMAIN, createTestIssuer, type FetchLike, type TestIssuer } from './jwt.js';
import { defined } from '../../../src/__tests__/support/defined.js';

export type FetchMock = Mock<FetchLike>;

export type SignedSession = {
  /** Every non-JWKS request the worker makes; no implementation until the test sets one. */
  fetchMock: FetchMock;
  /** The signed token, readable once the file's `beforeAll` has run. */
  bearerToken: () => string;
  authHeaders: () => { Authorization: string };
}

export function serveSignedSession(sub: string): SignedSession {
  const fetchMock: FetchMock = vi.fn<FetchLike>();
  let tenant: TestIssuer | undefined;
  let token: string | undefined;

  beforeAll(async () => {
    tenant = await createTestIssuer(TEST_AUTH0_DOMAIN);
    token = await tenant.sign({ sub });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', defined(tenant).serveJwks(fetchMock));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bearerToken = () => defined(token);
  return {
    fetchMock,
    bearerToken,
    authHeaders: () => ({ Authorization: `Bearer ${bearerToken()}` }),
  };
}
