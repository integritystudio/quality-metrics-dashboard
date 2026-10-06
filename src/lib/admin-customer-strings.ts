/**
 * Every user-facing string the admin customer view shares with the Flutter customer app,
 * in one place so the parity test (`admin-customer-parity.test.ts`) can pin each to the
 * Dart source. Paths are in IntegrityLandingPage; the citation is the file and member.
 */
export const CUSTOMER_VIEW = {
  /** lib/pages/dashboard_page.dart. */
  hub: {
    title: 'Dashboard',
    orgLabel: 'Organization',
    empty: 'No organizations found.',
    cards: {
      billing: { label: 'Billing', description: 'Plan, billing status, renewal date' },
      usage: { label: 'Usage', description: 'Monthly usage summary by metric' },
      quota: { label: 'Quota', description: 'Minute burst and monthly quota limits' },
      entitlements: { label: 'Entitlements', description: 'Feature flags for your plan' },
      observability: { label: 'Observability', description: 'View your traces, logs, metrics, and evaluations' },
    },
  },
  /** lib/pages/billing_status_page.dart. */
  billing: {
    title: 'Billing Status',
    subtitle: 'Current plan and renewal information',
    defaultCardTitle: 'Plan',
    planRow: 'Plan',
    renewsRow: 'Renews on',
    cancelsRow: 'Cancels on',
    contractNote: 'This organization is billed by contract. Contact support to make changes.',
    noAccountNote: 'No billing account yet. Choose a plan to set one up.',
    manageBilling: 'Manage Billing',
    choosePlan: 'Choose a plan',
    status: { active: 'Active', pastDue: 'Past Due', other: 'Inactive' },
    /** `SignupTiers.enterprise` — lib/config/content/constants.dart. */
    contractPlan: 'enterprise',
  },
  /** lib/pages/usage_summary_page.dart. */
  usage: {
    title: 'Usage Summary',
    subtitle: 'Current month usage breakdown',
    cardTitle: 'Monthly Usage',
    currentPeriod: 'Current period',
    since: (periodStart: string) => `Since ${periodStart}`,
    unitsOfLimit: (used: number, limit: number) => `${used} / ${limit} units`,
    units: (used: number) => `${used} units`,
    unlimitedPlan: 'Unlimited plan',
    limitReached: 'Monthly limit reached',
    percentUsed: (percent: number) => `${percent}% used`,
    resets: (month: string, day: number) => `Resets ${month} ${day}, 00:00 UTC`,
    reachedAlertTitle: 'Monthly limit reached',
    reachedAlertMessage: (resetLabel: string) => `New requests are refused until the quota resets. ${resetLabel}.`,
    approachingAlertTitle: 'Approaching your monthly limit',
    approachingAlertMessage: (percent: number, limit: number, resetLabel: string) =>
      `You have used ${percent}% of this month's ${limit} units. ${resetLabel}.`,
    dailyUsage: 'Daily usage',
    breakdown: 'Breakdown by metric',
    columns: { metric: 'Metric', units: 'Units', requests: 'Requests' },
    empty: 'No usage data for this period.',
  },
  /** lib/pages/quota_status_page.dart. */
  quota: {
    title: 'Quota Status',
    subtitle: 'Minute burst and monthly usage limits',
    cardTitle: 'Quota Usage',
    minute: 'Minute',
    monthly: 'Monthly',
    usedOfLimit: (used: number, limit: number) => `${used} / ${limit}`,
    unlimited: (used: number) => `${used} (Unlimited)`,
    empty: 'No quota data available.',
  },
  /** lib/pages/entitlements_page.dart. */
  entitlements: {
    title: 'Entitlements',
    subtitle: 'Feature flags and limits for your plan',
    cardTitle: 'Feature Entitlements',
    columns: { feature: 'Feature', value: 'Value' },
    enabled: 'Enabled',
    disabled: 'Disabled',
    notAvailable: 'N/A',
    empty: 'No entitlements found for this organization.',
  },
  /** Shared across the pages (buttons, placeholders). */
  common: {
    refresh: 'Refresh',
    tryAgain: 'Try again',
    dash: '—',
  },
  /** `DashboardService` — lib/services/dashboard_service.dart. */
  errors: {
    auth: 'Authentication required. Please log in again.',
    forbidden: "You don't have permission to manage billing for this organization.",
    server: 'Server error. Please try again.',
    timeout: 'Connection timed out. Please try again.',
    network: 'Network error. Please try again.',
    unexpected: 'An unexpected error occurred.',
  },
} as const;

/**
 * What the admin view says that the customer app does not: the deliberate deviations the
 * epic lists (org name and id in every header, the CTA as a read-only label) plus the
 * navigation the clone needs around the hub.
 */
export const ADMIN_VIEW = {
  customersLink: 'Customers',
  backToHub: 'Back to customers',
  backToAdmin: 'Back to admin',
  orgIdLabel: 'Org id',
  unknownOrg: 'Unknown organization',
  quotaUninitialized: 'Quota not initialized for this organization.',
  openObservabilityFailed: 'Failed to open this organization in the dashboard',
} as const;
