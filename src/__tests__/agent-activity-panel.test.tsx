import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { AgentActivityPanel } from '../components/AgentActivityPanel.js';
import type { AgentStat } from '../hooks/useAgentStats.js';

function agent(agentName: string, invocations: number, errorRate: number): AgentStat {
  return {
    agentName,
    invocations,
    errors: 0,
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

const AGENTS = [agent('alpha', 5, 0.3), agent('bravo', 20, 0.1), agent('charlie', 10, 0.2)];

function renderedAgentOrder(): string[] {
  const [, ...bodyRows] = screen.getAllByRole('row');
  return bodyRows.map(row => within(row).getAllByRole('cell')[0]?.textContent ?? '');
}

afterEach(cleanup);

describe('AgentActivityPanel sorting', () => {
  it('lists agents by invocations, most first, on load', () => {
    render(<AgentActivityPanel agents={AGENTS} />);

    expect(renderedAgentOrder()).toEqual(['bravo', 'charlie', 'alpha']);
    expect(screen.getByRole('columnheader', { name: /Invocations/ })).toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts a newly chosen column descending first', () => {
    render(<AgentActivityPanel agents={AGENTS} />);

    fireEvent.click(screen.getByRole('button', { name: /Error Rate/ }));

    expect(renderedAgentOrder()).toEqual(['alpha', 'charlie', 'bravo']);
    expect(screen.getByRole('columnheader', { name: /Invocations/ })).toHaveAttribute('aria-sort', 'none');
  });

  it('flips direction on a second click and never clears the sort', () => {
    render(<AgentActivityPanel agents={AGENTS} />);
    const header = screen.getByRole('columnheader', { name: /Invocations/ });
    const sortButton = within(header).getByRole('button');

    fireEvent.click(sortButton);
    expect(renderedAgentOrder()).toEqual(['alpha', 'charlie', 'bravo']);
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    fireEvent.click(sortButton);
    expect(renderedAgentOrder()).toEqual(['bravo', 'charlie', 'alpha']);
    expect(header).toHaveAttribute('aria-sort', 'descending');
  });

  it('leaves the agent column unsortable', () => {
    render(<AgentActivityPanel agents={AGENTS} />);
    const header = screen.getByRole('columnheader', { name: 'Agent' });

    expect(header).not.toHaveAttribute('aria-sort');
    expect(within(header).queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the sort button by its column label alone, without the arrow', () => {
    render(<AgentActivityPanel agents={AGENTS} />);

    expect(screen.getByRole('button', { name: 'Invocations' })).toBeInTheDocument();
  });
});

describe('AgentActivityPanel source column', () => {
  it('shows the most frequent source type', () => {
    const withSources = { ...agent('alpha', 1, 0), sourceTypes: { hook: 1, transcript: 3, other: 2 } };
    render(<AgentActivityPanel agents={[withSources]} />);

    expect(screen.getByText('transcript')).toBeInTheDocument();
  });
});
