import { apiFetch } from './api-client.js';
import type { FrontendActivityEvent } from '../types/activity.js';
import { CONTENT_TYPE_HEADER, ContentType } from './http-constants.js';

const ACTIVITY_TIMEOUT_MS = 3000;

/**
 * Fire-and-forget activity logging for frontend auth events.
 * Failures are intentionally swallowed — audit logging must not block auth flows.
 * 3s timeout prevents hung fetch from blocking on slow networks.
 */
export async function postActivityEvent(activityType: FrontendActivityEvent, jwt: string): Promise<void> {
  try {
    await apiFetch(`/api/activity`, jwt, null, {
      method: 'POST',
      headers: { [CONTENT_TYPE_HEADER]: ContentType.Json },
      body: JSON.stringify({ activity_type: activityType }),
      signal: AbortSignal.timeout(ACTIVITY_TIMEOUT_MS),
    });
  } catch (err) {
    // Warn in development so audit trail failures are visible during debugging.
    // Swallowed in production — audit logging must not block auth flows.
    if (import.meta.env.DEV) {
      console.warn('[activity-logger] Failed to post activity event:', activityType, err);
    }
  }
}
