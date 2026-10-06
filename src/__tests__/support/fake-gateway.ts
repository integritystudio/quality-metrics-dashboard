/**
 * An in-memory api-gateway for the admin customer view's tests, installed as `fetch`.
 *
 * Gateway requests are matched by path under {@link API_GATEWAY_URL}; the dashboard
 * worker's `POST /api/org/switch`, which the hub's Observability card calls, answers `{}`.
 * `control.refuse` makes every gateway call fail the chosen way so error paths can be
 * driven without touching the fixtures; `control.refuseRoute` narrows it to one route, so a
 * poll can fail after a first load succeeded.
 */
import { vi } from 'vitest';
import { API_GATEWAY_URL } from '../../lib/gateway.js';
import { headersOf } from './query-harness.js';

export type GatewayRoute = 'directory' | 'billing' | 'usage' | 'quota' | 'entitlements';
export type GatewayRefusal = { status: number; body?: unknown } | 'network-error';

export interface GatewayRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
}

type Responders = Partial<Record<GatewayRoute, (orgId: string) => unknown>>;

const HTTP_OK = 200;
const SWITCH_PATH = '/api/org/switch';
const ADMIN_ORGS = '/v1/admin/orgs';

const ROUTE_PATTERNS: Array<[GatewayRoute, RegExp]> = [
  ['directory', /^\/v1\/admin\/orgs$/],
  ['billing', /^\/v1\/admin\/orgs\/([^/]+)\/billing-status$/],
  ['usage', /^\/v1\/admin\/orgs\/([^/]+)\/usage\/summary$/],
  ['quota', /^\/v1\/admin\/orgs\/([^/]+)\/quota\/status$/],
  ['entitlements', /^\/v1\/admin\/orgs\/([^/]+)\/entitlements$/],
];

function json(body: unknown, status = HTTP_OK): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function startFakeGateway(responders: Responders) {
  const requests: GatewayRequest[] = [];
  const control: { refuse: GatewayRefusal | null; refuseRoute: GatewayRoute | null } = { refuse: null, refuseRoute: null };

  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const isGateway = input.startsWith(API_GATEWAY_URL);
    const path = isGateway ? input.slice(API_GATEWAY_URL.length) : input;
    requests.push({ method, url: input, path, headers: headersOf(init) });

    if (path === SWITCH_PATH && method === 'POST') return Promise.resolve(json({}));
    if (!isGateway) throw new Error(`fake gateway has no route for ${method} ${input}`);

    const matched = ROUTE_PATTERNS.map(([route, pattern]) => [route, pattern.exec(path)] as const).find(([, m]) => m !== null);
    if (!matched) throw new Error(`fake gateway has no route for ${method} ${path}`);
    const [route, match] = matched;

    const refusal = control.refuse !== null && (control.refuseRoute === null || control.refuseRoute === route) ? control.refuse : null;
    if (refusal === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
    if (refusal) return Promise.resolve(json(refusal.body ?? { error: { message: 'refused' } }, refusal.status));

    const responder = responders[route];
    if (!responder) throw new Error(`fake gateway has no fixture for ${route}`);
    return Promise.resolve(json(responder(match![1] ?? '')));
  }));

  return {
    control,
    requests,
    gatewayRequests: () => requests.filter((r) => r.url.startsWith(API_GATEWAY_URL)),
    requestsFor: (route: GatewayRoute) => {
      const pattern = ROUTE_PATTERNS.find(([name]) => name === route)![1];
      return requests.filter((r) => r.url.startsWith(API_GATEWAY_URL) && pattern.test(r.path));
    },
    switchRequests: () => requests.filter((r) => r.path === SWITCH_PATH),
  };
}

export { ADMIN_ORGS as FAKE_GATEWAY_DIRECTORY_PATH };
