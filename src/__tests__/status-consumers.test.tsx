/**
 * Components coloured by a status. Most carry their own `data-status`, which
 * theme.css maps to `--s-fg`; AgentActivitySummary renders a `text-<status>`
 * class through StatDisplay instead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AlertList } from '../components/AlertList.js';
import { AgentActivityPanel, AgentActivitySummary } from '../components/AgentActivityPanel.js';
import { ConfidencePanel } from '../components/ConfidencePanel.js';
import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { SpanTree } from '../components/SpanTree.js';
import type { AgentStat } from '../hooks/useAgentStats.js';
import type { TriggeredAlert } from '../types.js';
import { ERROR_RATE_WARNING_THRESHOLD, FUNNEL_DROPOFF_WARN_PCT, OTEL_STATUS_ERROR_CODE } from '../lib/constants.js';

const OTEL_STATUS_OK_CODE = 1;
const THRESHOLD = 0.7;
const BELOW_THRESHOLD = 0.6;
const ABOVE_THRESHOLD = 0.8;
const AGENT_INVOCATIONS = 100;

afterEach(cleanup);

function compoundAlert(overrides: Partial<TriggeredAlert>): TriggeredAlert {
  return {
    severity: 'warning',
    message: 'Compound alert',
    aggregation: 'avg',
    threshold: THRESHOLD,
    actualValue: BELOW_THRESHOLD,
    direction: 'below',
    isCompound: true,
    ...overrides,
  };
}

function agentWithErrorRate(errorRate: number): AgentStat {
  return {
    agentName: 'alpha',
    invocations: AGENT_INVOCATIONS,
    errors: Math.round(errorRate * AGENT_INVOCATIONS),
    errorRate,
    rateLimitCount: 0,
    avgOutputSize: 0,
    sessionCount: 0,
    sessionIds: [],
    sessionIdsTruncated: false,
    traceIdsTotal: 0,
    traceIds: [],
    traceIdsTruncated: false,
    sourceTypes: {},
    dailyCounts: [],
    evalSummary: {},
  };
}

describe('AlertList threshold bar', () => {
  it.each([
    { name: 'below a floor', direction: 'below', actualValue: BELOW_THRESHOLD, status: 'critical' },
    { name: 'above a floor', direction: 'below', actualValue: ABOVE_THRESHOLD, status: 'healthy' },
    { name: 'exactly on a floor', direction: 'below', actualValue: THRESHOLD, status: 'healthy' },
    { name: 'above a ceiling', direction: 'above', actualValue: ABOVE_THRESHOLD, status: 'critical' },
    { name: 'below a ceiling', direction: 'above', actualValue: BELOW_THRESHOLD, status: 'healthy' },
    { name: 'exactly on a ceiling', direction: 'above', actualValue: THRESHOLD, status: 'healthy' },
  ] as const)('fills $status when the value is $name', ({ direction, actualValue, status }) => {
    const { container } = render(<AlertList alerts={[compoundAlert({ direction, actualValue })]} />);

    expect(container.querySelector('.threshold-bar-fill')).toHaveAttribute('data-status', status);
  });

  it('keeps the bar on its own status inside an alert of another severity', () => {
    const alert = compoundAlert({ severity: 'critical', actualValue: ABOVE_THRESHOLD });

    const { container } = render(<AlertList alerts={[alert]} />);

    expect(container.querySelector('.alert-item')).toHaveAttribute('data-status', 'critical');
    expect(container.querySelector('.threshold-bar-fill')).toHaveAttribute('data-status', 'healthy');
  });
});

describe('AgentActivityPanel error rate', () => {
  it.each([
    { name: 'no errors', errorRate: 0, status: 'healthy' },
    { name: 'a rate under the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD / 2, status: 'warning' },
    { name: 'a rate on the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD, status: 'critical' },
    { name: 'a rate over the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD * 2, status: 'critical' },
  ])('marks $name as $status', ({ errorRate, status }) => {
    const { container } = render(<AgentActivityPanel agents={[agentWithErrorRate(errorRate)]} />);

    expect(container.querySelector('.agent-err-rate')).toHaveAttribute('data-status', status);
  });
});

describe('AgentActivitySummary error rate', () => {
  it.each([
    { name: 'no errors', errorRate: 0, status: 'healthy' },
    { name: 'a rate under the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD / 2, status: 'warning' },
    { name: 'a rate on the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD, status: 'critical' },
    { name: 'a rate over the warning threshold', errorRate: ERROR_RATE_WARNING_THRESHOLD * 2, status: 'critical' },
  ])('tones $name as $status', ({ errorRate, status }) => {
    render(<AgentActivitySummary agents={[agentWithErrorRate(errorRate)]} />);

    const value = screen.getByText('Error Rate').parentElement?.querySelector('.value');
    expect(value).toHaveClass(`text-${status}`);
  });
});

describe('ConfidencePanel level', () => {
  it.each([
    { level: 'high', status: 'healthy' },
    { level: 'medium', status: 'warning' },
    { level: 'low', status: 'critical' },
  ] as const)('marks $level confidence as $status', ({ level, status }) => {
    const { container } = render(
      <ConfidencePanel
        confidence={{ level, sampleCount: 10, scoreStdDev: null, evaluatorCount: 1, evaluatorAgreement: null }}
      />,
    );

    expect(container.querySelector('.confidence-level-indicator')).toHaveAttribute('data-status', status);
  });
});

describe('PipelineFunnel drop-off', () => {
  const stages = [
    { name: 'ingested', displayName: 'Ingested', entryCount: 100, exitCount: 75 },
    { name: 'judged', displayName: 'Judged', entryCount: 75, exitCount: 75 },
  ];

  it.each([
    { name: 'over the warning threshold', dropoffPercent: FUNNEL_DROPOFF_WARN_PCT + 1, status: 'warning' },
    { name: 'on the warning threshold', dropoffPercent: FUNNEL_DROPOFF_WARN_PCT, status: 'info' },
    { name: 'under the warning threshold', dropoffPercent: FUNNEL_DROPOFF_WARN_PCT - 1, status: 'info' },
  ])('marks a drop-off $name as $status', ({ dropoffPercent, status }) => {
    const dropoffs = [{ stage: 'ingested', dropped: 25, dropoffPercent }];

    const { container } = render(<PipelineFunnel stages={stages} dropoffs={dropoffs} overallConversionPercent={75} />);

    expect(container.querySelector('.funnel-dropoff')).toHaveAttribute('data-status', status);
  });
});

describe('SpanTree span status', () => {
  function renderSpan(status: { code: number } | undefined) {
    render(
      <SpanTree
        spans={[{ spanId: 's1', name: 'tool.call', durationMs: 50, ...(status && { status }) }]}
        evalsBySpan={new Map()}
        maxDuration={100}
      />,
    );
    const row = screen.getByText('tool.call').closest('.span-row');
    return {
      icon: row?.querySelector('.span-status-icon'),
      bar: row?.querySelector('.span-bar'),
    };
  }

  it('marks the icon and the bar of an errored span critical', () => {
    const { icon, bar } = renderSpan({ code: OTEL_STATUS_ERROR_CODE });

    expect(icon).toHaveAttribute('data-status', 'critical');
    expect(bar).toHaveAttribute('data-status', 'critical');
  });

  it.each([
    { name: 'an OK span', status: { code: OTEL_STATUS_OK_CODE } },
    { name: 'a span with no status', status: undefined },
  ])('leaves the icon unmarked and the bar healthy for $name', ({ status }) => {
    const { icon, bar } = renderSpan(status);

    expect(icon).not.toHaveAttribute('data-status');
    expect(bar).toHaveAttribute('data-status', 'healthy');
  });
});
