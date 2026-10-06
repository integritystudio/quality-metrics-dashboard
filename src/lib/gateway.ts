/**
 * The api-gateway client for the admin customer view (ADMIN-CV-API-CLIENT).
 *
 * The customer data lives on api-gateway, a different origin from this app, so these
 * calls are cross-origin and deliberately bypass `apiFetch`: that helper adds `X-Org-Id`,
 * which the gateway's CORS (`Authorization, Content-Type`) would make the browser refuse,
 * and which means nothing there anyway — the viewed org travels in the path, and it is not
 * the admin's active org. Only `Authorization` is sent. The token already carries the
 * gateway's audience, so there is no second login.
 */
import { CUSTOMER_VIEW } from './admin-customer-strings.js';

/** Production api-gateway; the build sets VITE_API_GATEWAY_URL to point elsewhere (dev: api-gateway-dev). */
export const DEFAULT_API_GATEWAY_URL = 'https://api.integritystudio.dev';

const configuredGatewayUrl = ((import.meta.env.VITE_API_GATEWAY_URL as string | undefined) ?? '').replace(/\/$/, '');
export const API_GATEWAY_URL = configuredGatewayUrl.length > 0 ? configuredGatewayUrl : DEFAULT_API_GATEWAY_URL;

/** `DashboardService`'s guard: an org id that could alter the path or query is never sent. */
const ORG_ID_UNSAFE_PATTERN = /[/?#%]/;

export function isSafeOrgId(orgId: string): boolean {
  return orgId.length > 0 && !ORG_ID_UNSAFE_PATTERN.test(orgId);
}

const ADMIN_ORGS_PATH = '/v1/admin/orgs';

/** The gateway paths, relative to {@link API_GATEWAY_URL}. Org paths are null for an unsafe id. */
export const gatewayPaths = {
  adminOrgs: () => ADMIN_ORGS_PATH,
  adminBillingStatus: (orgId: string) => orgPath(orgId, '/billing-status'),
  adminUsageSummary: (orgId: string) => orgPath(orgId, '/usage/summary'),
  adminQuotaStatus: (orgId: string) => orgPath(orgId, '/quota/status'),
  adminEntitlements: (orgId: string) => orgPath(orgId, '/entitlements'),
} as const;

function orgPath(orgId: string, subPath: string): string | null {
  return isSafeOrgId(orgId) ? `${ADMIN_ORGS_PATH}/${orgId}${subPath}` : null;
}

/** A GET against the gateway with the bearer token and nothing else. */
export function gatewayFetch(path: string, token: string, init?: { signal?: AbortSignal }): Promise<Response> {
  return fetch(`${API_GATEWAY_URL}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
    signal: init?.signal,
  });
}

export type GatewayErrorKind = 'auth' | 'forbidden' | 'server' | 'timeout' | 'network' | 'unexpected';

const GATEWAY_ERROR_MESSAGES: Record<GatewayErrorKind, string> = {
  auth: CUSTOMER_VIEW.errors.auth,
  forbidden: CUSTOMER_VIEW.errors.forbidden,
  server: CUSTOMER_VIEW.errors.server,
  timeout: CUSTOMER_VIEW.errors.timeout,
  network: CUSTOMER_VIEW.errors.network,
  unexpected: CUSTOMER_VIEW.errors.unexpected,
};

/** A gateway failure with `DashboardService`'s wording as its message. */
export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status: number | undefined;

  constructor(kind: GatewayErrorKind, status?: number) {
    super(GATEWAY_ERROR_MESSAGES[kind]);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = status;
  }
}

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
/** The two statuses `DashboardService` retries before reporting a server error. */
const HTTP_RETRIED_STATUSES: ReadonlySet<number> = new Set([500, 504]);
const TIMEOUT_ERROR_NAME = 'TimeoutError';

/** `_sanitizeReadError` plus the retried-status branch: 401, 403, 500/504, and the rest as unexpected. */
export function gatewayErrorForStatus(status: number): GatewayError {
  if (status === HTTP_UNAUTHORIZED) return new GatewayError('auth', status);
  if (status === HTTP_FORBIDDEN) return new GatewayError('forbidden', status);
  if (HTTP_RETRIED_STATUSES.has(status)) return new GatewayError('server', status);
  return new GatewayError('unexpected', status);
}

/** The `DioException` branch: a timeout, a failed connection, or something else. */
export function gatewayErrorForException(error: unknown, signal: AbortSignal): GatewayError {
  if (signal.aborted) {
    const reason: unknown = signal.reason;
    if (reason instanceof DOMException && reason.name === TIMEOUT_ERROR_NAME) return new GatewayError('timeout');
    // The query was cancelled (its key moved on); react-query discards the result either way.
    return new GatewayError('unexpected');
  }
  if (error instanceof TypeError) return new GatewayError('network');
  return new GatewayError('unexpected');
}

/** Which failures `DashboardService` retries: the server statuses and the transport errors. */
export function isRetryableGatewayError(error: unknown): boolean {
  return error instanceof GatewayError && (error.kind === 'server' || error.kind === 'timeout' || error.kind === 'network');
}

/**
 * A signal that aborts when `outer` does or when `ms` elapses, whichever is first. The
 * timeout reason is a `TimeoutError` so the caller can tell it from a cancellation.
 */
export function withTimeout(outer: AbortSignal | undefined, ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The request timed out', TIMEOUT_ERROR_NAME)), ms);
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuterAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}
