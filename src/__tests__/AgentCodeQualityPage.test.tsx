import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { PageShellProps } from './test-types.js';
import type { AgentWindowStats, CodeQualityResponse } from '../api/routes/code-quality.js';

/**
 * AgentCodeQualityPage splits survival rows by cohort (CSV2) and content kind
 * (CSV3a): scored code is D7's input, baseline agents are the comparison
 * group, docs are reported but never scored. It also must not render blank
 * while only 3d/7d checkpoints exist — the state it was in on 2026-09-28.
 */

interface CodeQualityQueryResult {
  data: CodeQualityResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}

const mockUseCodeQuality = vi.fn<() => CodeQualityQueryResult>();
vi.mock('../hooks/useCodeQuality.js', () => ({
  useCodeQuality: () => mockUseCodeQuality(),
}));

vi.mock('../components/PageShell.js', () => ({
  PageShell: ({ children }: PageShellProps) => <div>{children}</div>,
}));

import { AgentCodeQualityPage } from '../pages/AgentCodeQualityPage.js';

const SCORED_TITLE = /Survival by Agent/;
const BASELINE_TITLE = /Baseline Agents/;
const DOC_TITLE = /Documentation/;

function row(overrides: Partial<AgentWindowStats>): AgentWindowStats {
  return {
    agentName: 'agent-auditor', agentVersion: '2026-09-24', window: '21d',
    cohort: 'scored', contentKind: 'code',
    avgSurvivalRate: 0.9, avgChurnRate: 0.1, avgDeletionRate: 0,
    checkpointCount: 1, latestTimestamp: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

function renderWith(rows: AgentWindowStats[]): void {
  mockUseCodeQuality.mockReturnValue({
    data: { survivalByAgentWindow: rows, versionRollout: [], hasData: rows.length > 0 },
    isLoading: false,
    error: null,
  });
  render(<AgentCodeQualityPage />);
}

function tableUnder(title: RegExp): HTMLElement {
  return screen.getByRole('heading', { name: title }).closest('.card') as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentCodeQualityPage', () => {
  it('puts scored code, baseline code and docs in separate tables', () => {
    renderWith([
      row({}),
      row({ agentName: 'general-purpose', cohort: 'baseline' }),
      row({ agentName: 'documentation-architect', contentKind: 'doc', avgSurvivalRate: 0 }),
    ]);

    expect(within(tableUnder(SCORED_TITLE)).getByText('agent-auditor')).toBeTruthy();
    expect(within(tableUnder(BASELINE_TITLE)).getByText('general-purpose')).toBeTruthy();
    expect(within(tableUnder(DOC_TITLE)).getByText('documentation-architect')).toBeTruthy();
    expect(within(tableUnder(SCORED_TITLE)).queryByText('general-purpose')).toBeNull();
  });

  it('badges baseline rows and flags low survival only in the scored table', () => {
    renderWith([
      row({ agentName: 'general-purpose', cohort: 'baseline', avgSurvivalRate: 0.1 }),
      row({ agentName: 'documentation-architect', contentKind: 'doc', avgSurvivalRate: 0 }),
    ]);

    expect(within(tableUnder(BASELINE_TITLE)).getByLabelText('Baseline cohort: not scored')).toBeTruthy();
    expect(screen.queryByLabelText('Below survival threshold')).toBeNull();
  });

  it('shows progress instead of a blank page while only early windows exist', () => {
    renderWith([row({ window: '3d', agentName: 'documentation-architect', contentKind: 'doc' })]);

    expect(screen.getByText(/1 earlier-window \(3d \/ 7d\) checkpoint so far/)).toBeTruthy();
    expect(screen.queryByRole('heading', { name: SCORED_TITLE })).toBeNull();
  });
});
