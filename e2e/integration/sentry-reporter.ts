/**
 * Playwright reporter that captures integration test failures to Sentry.
 * Only active when SENTRY_DSN is set in the environment.
 *
 * Reports: failed + timed-out tests with title, errors, and suite context.
 */

import * as Sentry from '@sentry/node';
import type { Reporter, TestCase, TestResult, FullConfig } from '@playwright/test/reporter';

const FLUSH_TIMEOUT_MS = 5_000;

export default class SentryReporter implements Reporter {
  private initialized = false;

  onBegin(config: FullConfig): void {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;

    Sentry.init({
      dsn,
      environment: 'e2e-integration',
      release: process.env.npm_package_version,
      tracesSampleRate: 0,
    });

    Sentry.setTag('playwright.project', config.projects[0]?.name ?? 'integration');
    this.initialized = true;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (!this.initialized) return;
    if (result.status !== 'failed' && result.status !== 'timedOut') return;

    const title = test.titlePath().join(' › ');
    const errorMessages = result.errors.map(e => e.message ?? String(e)).join('\n---\n');
    const err = new Error(`E2E failure: ${title}\n\n${errorMessages}`);
    err.name = result.status === 'timedOut' ? 'E2ETimeout' : 'E2EFailure';

    Sentry.withScope(scope => {
      scope.setTag('test.status', result.status);
      scope.setTag('test.suite', test.parent.title);
      scope.setContext('test', {
        title,
        duration_ms: result.duration,
        retry: result.retry,
        errors: result.errors.map(e => ({ message: e.message, location: e.location })),
      });
      Sentry.captureException(err);
    });
  }

  async onEnd(): Promise<void> {
    if (!this.initialized) return;
    await Sentry.flush(FLUSH_TIMEOUT_MS);
  }
}
