import { z } from 'zod';

/**
 * Dashboard lookback periods. Worker-safe: this module has no `import.meta.env` access, so
 * it can be imported by `worker/` and API-server code alike.
 */
export const PERIOD_KEYS = ['24h', '7d', '30d'] as const;
export const PeriodEnum = z.enum(PERIOD_KEYS);
export type Period = z.infer<typeof PeriodEnum>;
/** Default period for list/evaluation queries. */
export const DEFAULT_PERIOD = '7d' satisfies Period;
/** Default period for metric detail views (wider window). */
export const DEFAULT_PERIOD_DETAIL = '30d' satisfies Period;
