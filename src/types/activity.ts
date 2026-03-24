/**
 * Shared activity logging type definitions for worker and frontend
 */

export const USER_ACTIVITY_EVENTS = ['login', 'logout', 'dashboard_view', 'trace_view', 'session_view', 'compliance_view'] as const;
export type UserActivityEvent = typeof USER_ACTIVITY_EVENTS[number];

export const FRONTEND_ACTIVITY_EVENTS = ['login', 'logout'] as const;
export type FrontendActivityEvent = typeof FRONTEND_ACTIVITY_EVENTS[number];
