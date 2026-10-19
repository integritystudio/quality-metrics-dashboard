import { z } from 'zod';

/**
 * Dashboard lookback periods. Worker-safe: this module has no `import.meta.env` access, so
 * it can be imported by `worker/` and API-server code alike.
 */
export const PERIOD_KEYS = ['24h', '7d', '30d', '90d'] as const;
export const PeriodEnum = z.enum(PERIOD_KEYS);
/** The 400 message for a bad `period`, listing {@link PERIOD_KEYS} so it follows the list. */
export const INVALID_PERIOD_MESSAGE = `Invalid period. Must be ${new Intl.ListFormat('en', { type: 'disjunction' }).format(PERIOD_KEYS)}.`;
export type Period = z.infer<typeof PeriodEnum>;
/** Default period for list/evaluation queries. */
export const DEFAULT_PERIOD = '7d' satisfies Period;
/** Default period for metric detail views (wider window). */
export const DEFAULT_PERIOD_DETAIL = '30d' satisfies Period;
/** The period the dashboard opens on; the e2e worker fixture warms this read before any spec runs. */
export const INITIAL_PERIOD = '30d' satisfies Period;
