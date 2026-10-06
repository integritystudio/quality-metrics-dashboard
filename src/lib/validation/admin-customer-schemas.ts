/**
 * The api-gateway payloads the admin customer view reads, parsed the way the Flutter
 * models parse them (IntegrityLandingPage lib/models/dashboard_models.dart): every field
 * optional with the Dart default, so the clone renders exactly what the customer sees
 * from the same bytes. Each schema is cited to its Dart class.
 */
import { z } from 'zod';

/** `@Default('')` on a `String`: absent and null both read as empty. */
const stringOrEmpty = z.string().nullish().transform((v) => v ?? '');
/** `@Default(0)` on an `int`: json_serializable truncates a double and reads null as 0. */
const intOrZero = z.number().nullish().transform((v) => Math.trunc(v ?? 0));
/** A Dart `is List ? ... : []` read: anything but a list is an empty one. */
const listOf = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((raw: unknown): unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []), z.array(item));
/** A Dart `is Map ? ... : {}` read. */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `OrgSummary` — what `GET /v1/admin/orgs` lists per org; the directory replaces `/v1/orgs`. */
export const AdminOrgSummarySchema = z.object({
  id: stringOrEmpty,
  name: stringOrEmpty,
  slug: z.string().nullish().transform((v) => v ?? null),
  billing_status: z.string().nullish().transform((v) => v ?? 'inactive'),
  current_plan: z.string().nullish().transform((v) => v ?? null),
}).transform((raw) => ({
  id: raw.id,
  name: raw.name,
  slug: raw.slug,
  billingStatus: raw.billing_status,
  currentPlan: raw.current_plan,
}));
export type AdminOrgSummary = z.infer<typeof AdminOrgSummarySchema>;

/** `DashboardService.fetchOrgList`: `organizations` must be a list, else no orgs. */
export const AdminOrgDirectorySchema = z.object({
  organizations: listOf(AdminOrgSummarySchema),
}).transform((raw) => raw.organizations);

/** `BillingStatusData.fromJson`: `current_plan` with the older `plan_key` as fallback; a bad date is null. */
export const BillingStatusSchema = z.object({
  current_plan: z.string().nullish(),
  plan_key: z.string().nullish(),
  plan_display_name: z.string().nullish(),
  billing_status: z.string().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  current_period_end: z.string().nullish(),
  has_billing_account: z.boolean().nullish(),
}).transform((raw) => ({
  planKey: raw.current_plan ?? raw.plan_key ?? '',
  planDisplayName: raw.plan_display_name ?? '',
  billingStatus: raw.billing_status ?? 'inactive',
  cancelAtPeriodEnd: raw.cancel_at_period_end ?? false,
  nextRenewalDate: parseDate(raw.current_period_end),
  hasBillingAccount: raw.has_billing_account ?? false,
}));
export type BillingStatusData = z.infer<typeof BillingStatusSchema>;

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `UsageBucket`. */
export const UsageBucketSchema = z.object({
  bucket_date: stringOrEmpty,
  metric_key: stringOrEmpty,
  total_quantity: intOrZero,
  request_count: intOrZero,
  avg_latency_ms: z.number().nullish().transform((v) => v ?? null),
}).transform((raw) => ({
  bucketDate: raw.bucket_date,
  metricKey: raw.metric_key,
  totalQuantity: raw.total_quantity,
  requestCount: raw.request_count,
  avgLatencyMs: raw.avg_latency_ms,
}));
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

/** `UsageSummaryData.fromJson`. */
export const UsageSummarySchema = z.object({
  org_id: stringOrEmpty,
  period_start: stringOrEmpty,
  buckets: listOf(UsageBucketSchema),
}).transform((raw) => ({
  orgId: raw.org_id,
  periodStart: raw.period_start,
  buckets: raw.buckets,
}));
export type UsageSummaryData = z.infer<typeof UsageSummarySchema>;

/** `EntitlementsData.fromJson`: the map's values are whatever the gateway sent (`Map<String, Object?>`). */
export const EntitlementsSchema = z.object({
  org_id: stringOrEmpty,
  entitlements: z.unknown().optional(),
}).transform((raw) => ({
  orgId: raw.org_id,
  entitlements: isRecord(raw.entitlements) ? raw.entitlements : {},
}));
export type EntitlementsData = z.infer<typeof EntitlementsSchema>;

/**
 * `QuotaStatusData.fromJson`. The gateway answers `{status: 'uninitialized'}` when the
 * Durable Object is unavailable; Dart parses that into the defaults below with no plan,
 * so the customer sees "Minute: 0 / 0" and "Monthly: 0 (Unlimited)". `uninitialized` is
 * the admin view's own flag for that case; nothing in the Dart model carries it.
 */
export const QuotaStatusSchema = z.object({
  status: z.string().nullish(),
  planKey: z.string().nullish(),
  minuteLimit: intOrZero,
  minuteUsed: intOrZero,
  monthlyLimit: z.number().nullish().transform((v) => (v == null ? null : Math.trunc(v))),
  monthlyUsed: intOrZero,
  minuteWindowExpiresIn: intOrZero,
}).transform((raw) => ({
  planKey: raw.planKey ?? null,
  minuteLimit: raw.minuteLimit,
  minuteUsed: raw.minuteUsed,
  monthlyLimit: raw.monthlyLimit,
  monthlyUsed: raw.monthlyUsed,
  minuteWindowExpiresInMs: raw.minuteWindowExpiresIn,
  uninitialized: raw.status === 'uninitialized',
}));
export type QuotaStatusData = z.infer<typeof QuotaStatusSchema>;
