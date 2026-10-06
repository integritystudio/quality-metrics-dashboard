/**
 * The gateway payload schemas against the Dart parsers' defaults
 * (IntegrityLandingPage lib/models/dashboard_models.dart): a missing or null field reads
 * as the Flutter default, a non-list reads as empty, and the billing plan falls back from
 * `current_plan` to `plan_key`.
 */
import { describe, it, expect } from 'vitest';
import {
  AdminOrgDirectorySchema,
  BillingStatusSchema,
  EntitlementsSchema,
  QuotaStatusSchema,
  UsageSummarySchema,
} from '../lib/validation/admin-customer-schemas.js';
import { BILLING_ACTIVE, ENTITLEMENTS_GROWTH, ORG_A, QUOTA_GROWTH, QUOTA_UNINITIALIZED, USAGE_SUMMARY } from './support/admin-customer-fixtures.js';

describe('AdminOrgDirectorySchema (OrgSummary, fetchOrgList)', () => {
  it('maps the five directory fields', () => {
    expect(AdminOrgDirectorySchema.parse({ organizations: [ORG_A] })).toEqual([
      { id: ORG_A.id, name: 'Acme', slug: 'acme', billingStatus: 'active', currentPlan: 'growth' },
    ]);
  });

  it('applies the Dart defaults to a sparse row', () => {
    expect(AdminOrgDirectorySchema.parse({ organizations: [{ id: 'x' }] })).toEqual([
      { id: 'x', name: '', slug: null, billingStatus: 'inactive', currentPlan: null },
    ]);
  });

  it.each([
    ['a non-list', { organizations: 'nope' }],
    ['a missing key', {}],
  ])('reads %s as no orgs', (_label, body) => {
    expect(AdminOrgDirectorySchema.parse(body)).toEqual([]);
  });

  it('rejects a row whose field has the wrong type, as a Dart cast would', () => {
    expect(AdminOrgDirectorySchema.safeParse({ organizations: [{ id: 42 }] }).success).toBe(false);
  });
});

describe('BillingStatusSchema (BillingStatusData.fromJson)', () => {
  it('reads the gateway payload', () => {
    expect(BillingStatusSchema.parse(BILLING_ACTIVE)).toEqual({
      planKey: 'growth',
      planDisplayName: '',
      billingStatus: 'active',
      cancelAtPeriodEnd: false,
      nextRenewalDate: null,
      hasBillingAccount: true,
    });
  });

  it('prefers current_plan and falls back to plan_key', () => {
    expect(BillingStatusSchema.parse({ current_plan: 'growth', plan_key: 'starter' }).planKey).toBe('growth');
    expect(BillingStatusSchema.parse({ plan_key: 'starter' }).planKey).toBe('starter');
    expect(BillingStatusSchema.parse({ current_plan: null, plan_key: 'starter' }).planKey).toBe('starter');
  });

  it('applies the Dart defaults to an empty body', () => {
    expect(BillingStatusSchema.parse({})).toEqual({
      planKey: '',
      planDisplayName: '',
      billingStatus: 'inactive',
      cancelAtPeriodEnd: false,
      nextRenewalDate: null,
      hasBillingAccount: false,
    });
  });

  it('parses the optional fields the endpoint does not send yet', () => {
    const parsed = BillingStatusSchema.parse({
      plan_display_name: 'Growth',
      cancel_at_period_end: true,
      current_period_end: '2026-11-15T00:00:00.000Z',
    });
    expect(parsed.planDisplayName).toBe('Growth');
    expect(parsed.cancelAtPeriodEnd).toBe(true);
    expect(parsed.nextRenewalDate?.toISOString()).toBe('2026-11-15T00:00:00.000Z');
  });

  it('reads an unparseable date as none', () => {
    expect(BillingStatusSchema.parse({ current_period_end: 'soon' }).nextRenewalDate).toBeNull();
    expect(BillingStatusSchema.parse({ current_period_end: '' }).nextRenewalDate).toBeNull();
  });
});

describe('UsageSummarySchema (UsageSummaryData.fromJson, UsageBucket)', () => {
  it('reads the gateway payload', () => {
    const parsed = UsageSummarySchema.parse(USAGE_SUMMARY);
    expect(parsed.orgId).toBe(ORG_A.id);
    expect(parsed.periodStart).toBe('2026-10-01');
    expect(parsed.buckets).toHaveLength(3);
    expect(parsed.buckets[0]).toEqual({ bucketDate: '2026-10-05', metricKey: 'requests', totalQuantity: 50, requestCount: 5, avgLatencyMs: null });
  });

  it('applies the Dart defaults to a sparse bucket and truncates a double count', () => {
    expect(UsageSummarySchema.parse({ buckets: [{ total_quantity: 12.9 }] })).toEqual({
      orgId: '',
      periodStart: '',
      buckets: [{ bucketDate: '', metricKey: '', totalQuantity: 12, requestCount: 0, avgLatencyMs: null }],
    });
  });

  it('reads a non-list buckets field as no buckets', () => {
    expect(UsageSummarySchema.parse({ buckets: { not: 'a list' } }).buckets).toEqual([]);
    expect(UsageSummarySchema.parse({}).buckets).toEqual([]);
  });
});

describe('EntitlementsSchema (EntitlementsData.fromJson)', () => {
  it('keeps the map as sent', () => {
    expect(EntitlementsSchema.parse(ENTITLEMENTS_GROWTH).entitlements).toEqual(ENTITLEMENTS_GROWTH.entitlements);
  });

  it.each([
    ['a list', { entitlements: [1, 2] }],
    ['a string', { entitlements: 'nope' }],
    ['a missing key', {}],
  ])('reads %s as an empty map', (_label, body) => {
    expect(EntitlementsSchema.parse(body).entitlements).toEqual({});
  });
});

describe('QuotaStatusSchema (QuotaStatusData.fromJson)', () => {
  it('reads an initialized payload', () => {
    expect(QuotaStatusSchema.parse(QUOTA_GROWTH)).toEqual({
      planKey: 'growth',
      minuteLimit: 60,
      minuteUsed: 5,
      monthlyLimit: 500000,
      monthlyUsed: 12345,
      minuteWindowExpiresInMs: 45000,
      uninitialized: false,
    });
  });

  it('keeps a null monthly limit, the unlimited marker', () => {
    expect(QuotaStatusSchema.parse({ ...QUOTA_GROWTH, monthlyLimit: null }).monthlyLimit).toBeNull();
  });

  it('parses the uninitialized answer into the Dart defaults and flags it', () => {
    expect(QuotaStatusSchema.parse(QUOTA_UNINITIALIZED)).toEqual({
      planKey: null,
      minuteLimit: 0,
      minuteUsed: 0,
      monthlyLimit: null,
      monthlyUsed: 0,
      minuteWindowExpiresInMs: 0,
      uninitialized: true,
    });
  });
});
