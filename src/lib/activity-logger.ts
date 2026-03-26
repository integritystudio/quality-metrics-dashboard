import { API_BASE } from './constants.js';
import type { FrontendActivityEvent } from '../types/activity.js';

const ACTIVITY_TIMEOUT_MS = 3000;

/**
 * Fire-and-forget activity logging for frontend auth events.
 * Failures are intentionally swallowed — audit logging must not block auth flows.
 * 3s timeout prevents hung fetch from blocking on slow networks.
 */
export async function postActivityEvent(activityType: FrontendActivityEvent, jwt: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ACTIVITY_TIMEOUT_MS);

  try {
    await fetch(`${API_BASE}/api/activity`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ activity_type: activityType }),
      signal: controller.signal,
    });
  } catch (err) {
    // CR-ERR-4: warn in development so audit trail failures are visible during debugging.
    // Swallowed in production — audit logging must not block auth flows.
    if (import.meta.env?.DEV) {
      console.warn('[activity-logger] Failed to post activity event:', activityType, err);
    }
  } finally {
    clearTimeout(timeout);
  }
}
