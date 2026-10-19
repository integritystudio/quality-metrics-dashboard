/**
 * Every response message and log token the worker's modules share. The worker cannot import
 * src/lib/constants.ts (date-fns, zod) or src/api/api-constants.ts (Node-only), so these are
 * stated here rather than restated at each use site.
 */

import { MAX_PAGE_LIMIT } from '../src/lib/worker-contract.js';
import { ROLES } from '../src/lib/roles.js';

const OR_LIST = new Intl.ListFormat('en', { type: 'disjunction' });

/** Joins allowed values as "a, b, or c" for the 400 messages, so they follow the shared lists. */
export function orList(values: Iterable<string>): string {
  return OR_LIST.format(values);
}

export const ERR_AUTH_UNAVAILABLE = 'Authentication service unavailable';
export const ERR_UNAUTHORIZED = 'Unauthorized';
export const ERR_FORBIDDEN = 'Forbidden';
export const ERR_INTERNAL = 'Internal server error';
export const ERR_NO_ORG = 'No organization membership';
export const ERR_FAILED_LOAD_USER_ROLES = 'Failed to load user roles';

export const ERR_INVALID_REQUEST_BODY = 'Invalid request body';
export const ERR_INVALID_QUERY = 'Invalid query parameters';
export const ERR_INVALID_ROLE = `Invalid role. Must be ${orList(ROLES)}.`;
export const ERR_INVALID_PAGINATION = `Invalid pagination params. limit must be 1–${MAX_PAGE_LIMIT}, offset must be >= 0.`;

export const ERR_INVALID_METRIC_NAME = 'Invalid metric name';
export const ERR_INVALID_TRACE_ID = 'Invalid traceId';
export const ERR_INVALID_SESSION_ID = 'Invalid sessionId';
export const ERR_INVALID_AGENT_ID = 'Invalid agentId';
export const ERR_INVALID_USER_ID = 'Invalid userId';
export const ERR_INVALID_ROLE_ID = 'Invalid roleId';
export const ERR_INVALID_KEY_ID = 'Invalid keyId';

export const ERR_ROUTING_TELEMETRY_MALFORMED = 'Routing telemetry data is malformed';
export const ERR_CALIBRATION_MALFORMED = 'Calibration data is malformed';

export const ERR_FETCH_MEMBERS = 'Failed to fetch members';
export const ERR_FETCH_MEMBER = 'Failed to fetch member';
export const ERR_UPDATE_MEMBER_ROLE = 'Failed to update member role';
export const ERR_REMOVE_MEMBER = 'Failed to remove member';
export const ERR_FETCH_USERS = 'Failed to fetch users';
export const ERR_FETCH_ROLE_ASSIGNMENTS = 'Failed to fetch role assignments';
export const ERR_FETCH_ROLES = 'Failed to fetch roles';
export const ERR_ASSIGN_ROLE = 'Failed to assign role';
export const ERR_REVOKE_ROLE = 'Failed to revoke role';
export const ERR_FETCH_KEYS = 'Failed to fetch keys';
export const ERR_KEY_NOT_FOUND_IN_ORG = 'Key not found in active org';
export const ERR_ROTATION_FAILED = 'Key rotation failed';

/** Stands in for the status in a log line when `fetch` produced no response at all. */
export const NO_RESPONSE_STATUS = 'network error';
