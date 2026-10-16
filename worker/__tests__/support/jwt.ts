/**
 * A stand-in Auth0 tenant for the worker's auth tests: one RS256 key pair, tokens signed with
 * it, and its key set served from the tenant's JWKS URL through the test's `fetch` stub.
 *
 * The worker verifies these with real jose, so issuer, audience, expiry, `kid` and signature
 * checks all run as in production. It caches each domain's key set for the isolate's lifetime,
 * so a test file uses one issuer per domain.
 */
import { CompactSign, SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { jsonResponse } from './http.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SIGNING_ALG = 'RS256';
const KEY_USE_SIGNATURE = 'sig';
const DEFAULT_TOKEN_LIFETIME = '5m';
export const TEST_AUTH0_DOMAIN = 'test.us.auth0.com';
export const TEST_AUDIENCE = 'https://test.api.dev';

export function issuerFor(domain: string): string {
  return `https://${domain}/`;
}

export function jwksUrlFor(domain: string): string {
  return `https://${domain}/.well-known/jwks.json`;
}

export type TokenClaims = {
  sub?: string;
  issuer?: string;
  audience?: string;
  /** Epoch seconds, a Date, or a jose timespan such as `5m`. */
  expiresAt?: number | string | Date;
}

export type TestIssuer = {
  readonly domain: string;
  readonly issuer: string;
  readonly kid: string;
  sign: (claims?: TokenClaims) => Promise<string>;
  /** A JWS over `payload` verbatim, signed with this tenant's key: for payloads that are not a claims set. */
  signPayload: (payload: string) => Promise<string>;
  /** Answers this tenant's JWKS URL with its public key and hands every other request on. */
  serveJwks: (fetchImpl: FetchLike) => FetchLike;
}

/** `kid` defaults to a fresh id; pass another issuer's to forge tokens under its key id. */
export async function createTestIssuer(domain: string, options: { kid?: string } = {}): Promise<TestIssuer> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG);
  const kid = options.kid ?? crypto.randomUUID();
  const publicJwk: JWK = { ...await exportJWK(publicKey), kid, alg: SIGNING_ALG, use: KEY_USE_SIGNATURE };
  const issuer = issuerFor(domain);
  const jwksUrl = jwksUrlFor(domain);

  return {
    domain,
    issuer,
    kid,
    sign({ sub, issuer: iss = issuer, audience = TEST_AUDIENCE, expiresAt = DEFAULT_TOKEN_LIFETIME } = {}) {
      const token = new SignJWT({})
        .setProtectedHeader({ alg: SIGNING_ALG, kid })
        .setIssuer(iss)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiresAt);
      if (sub !== undefined) token.setSubject(sub);
      return token.sign(privateKey);
    },
    signPayload(payload) {
      // Under jsdom, TextEncoder returns another realm's Uint8Array, which jose's instanceof check refuses.
      return new CompactSign(Uint8Array.from(new TextEncoder().encode(payload)))
        .setProtectedHeader({ alg: SIGNING_ALG, kid })
        .sign(privateKey);
    },
    serveJwks(fetchImpl) {
      return (url, init) => (url === jwksUrl ? Promise.resolve(jsonResponse({ keys: [publicJwk] })) : fetchImpl(url, init));
    },
  };
}
