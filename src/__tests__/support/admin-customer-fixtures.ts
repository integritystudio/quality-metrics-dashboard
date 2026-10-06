/**
 * Gateway payloads for the admin customer view's tests, one per route, shaped as
 * api-gateway returns them (`handleAdminListOrgs`, `loadBillingStatus`, `loadUsageSummary`,
 * `loadQuotaStatus`, `loadEntitlements` in IntegrityLandingPage workers/api-gateway).
 */
export const ORG_A = {
  id: 'a0000000-0000-4000-8000-00000000000a',
  name: 'Acme',
  slug: 'acme',
  billing_status: 'active',
  current_plan: 'growth',
};

export const ORG_B = {
  id: 'b0000000-0000-4000-8000-00000000000b',
  name: 'Beta Labs',
  slug: 'beta-labs',
  billing_status: 'inactive',
  current_plan: 'starter',
};

export const BILLING_ACTIVE = {
  org_id: ORG_A.id,
  billing_status: 'active',
  current_plan: 'growth',
  quota_version: 1,
  role: null,
  has_billing_account: true,
};

/** Three buckets over two dates, two metrics: the chart sums per date, the table per metric. */
export const USAGE_SUMMARY = {
  org_id: ORG_A.id,
  period_start: '2026-10-01',
  buckets: [
    { organization_id: ORG_A.id, bucket_date: '2026-10-05', metric_key: 'requests', total_quantity: 50, request_count: 5, avg_latency_ms: null },
    { organization_id: ORG_A.id, bucket_date: '2026-10-01', metric_key: 'requests', total_quantity: 100, request_count: 10, avg_latency_ms: 5 },
    { organization_id: ORG_A.id, bucket_date: '2026-10-05', metric_key: 'otel_spans', total_quantity: 300, request_count: 3, avg_latency_ms: 1 },
  ],
};

export const USAGE_EMPTY = { org_id: ORG_A.id, period_start: '2026-10-01', buckets: [] };

export const QUOTA_GROWTH = {
  org_id: ORG_A.id,
  orgId: ORG_A.id,
  planKey: 'growth',
  quotaVersion: 1,
  minuteLimit: 60,
  monthlyLimit: 500000,
  minuteUsed: 5,
  monthlyUsed: 12345,
  minuteWindowExpiresIn: 45000,
};

export const QUOTA_UNINITIALIZED = { org_id: ORG_A.id, status: 'uninitialized' };

export const ENTITLEMENTS_GROWTH = {
  org_id: ORG_A.id,
  entitlements: {
    usage_dashboard: true,
    alerts: false,
    monthly_units: 500000,
    concurrent_jobs: null,
  },
};

export const ENTITLEMENTS_EMPTY = { org_id: ORG_A.id, entitlements: {} };
