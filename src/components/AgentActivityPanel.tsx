import { Fragment, useCallback, useMemo, useState } from 'react';
import type { AgentStat, EvalMetricSummary } from '../hooks/useAgentStats.js';
import { scoreColor, fmtBytes, formatPercent } from '../lib/quality-utils.js';
import { TruncatedIdLink } from './TruncatedIdLink.js';
import {
  AGENT_PALETTE, ERROR_RATE_WARNING_THRESHOLD,
  AGENT_TABLE_MIN_WIDTH, AGENT_BAR_MIN_WIDTH, AGENT_EVAL_CARD_MIN_WIDTH,
  SPARKLINE_WIDTH, SPARKLINE_HEIGHT,
} from '../lib/constants.js';
import { routes } from '../lib/routes.js';
import { BarIndicator } from './BarIndicator.js';
import { EmptyState } from './EmptyState.js';
import { ExpandChevron } from './ExpandChevron.js';
import { Sparkline } from './Sparkline.js';
import { StatDisplay } from './StatDisplay.js';

const COLUMN_COUNT = 7;
type SortKey = 'invocations' | 'errorRate' | 'sessionCount' | 'avgOutputSize';

function errorRateColor(rate: number): string {
  if (rate === 0) return 'var(--status-healthy)';
  if (rate < ERROR_RATE_WARNING_THRESHOLD) return 'var(--status-warning)';
  return 'var(--status-critical)';
}


interface AgentActivityPanelProps {
  agents: AgentStat[];
}

export function AgentActivityPanel({ agents }: AgentActivityPanelProps) {
  const [sort, setSort] = useState<SortKey>('invocations');
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const colorIndex = useMemo(
    () => Array.isArray(agents)
      ? new Map(agents.map((a, i) => [a.agentName, AGENT_PALETTE[i % AGENT_PALETTE.length]]))
      : new Map<string, string>(),
    [agents],
  );

  // React 18+ batches both setState calls in event handlers atomically
  const toggleSort = useCallback((key: SortKey) => {
    if (key === sort) {
      setAsc(v => !v);
    } else {
      setSort(key);
      setAsc(false);
    }
  }, [sort]);

  if (agents.length === 0) {
    return <EmptyState message="No agent activity recorded for this period." />;
  }

  const maxInvocations = Math.max(...agents.map(a => a.invocations), 1);

  const sorted = [...agents].sort((a, b) => {
    const diff = a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0;
    return asc ? diff : -diff;
  });

  const sortIndicator = (key: SortKey) =>
    sort === key ? (asc ? ' \u2191' : ' \u2193') : '';

  return (
    <div className="overflow-x-auto">
      <table className="data-table sla-table" style={{ minWidth: AGENT_TABLE_MIN_WIDTH }}>
        <thead>
          <tr>
            <th className="col-agent">Agent</th>
            <th className="cursor-pointer select-none" onClick={() => toggleSort('invocations')}>
              Invocations{sortIndicator('invocations')}
            </th>
            <th className="cursor-pointer select-none" onClick={() => toggleSort('errorRate')}>
              Error Rate{sortIndicator('errorRate')}
            </th>
            <th className="cursor-pointer select-none" onClick={() => toggleSort('sessionCount')}>
              Sessions{sortIndicator('sessionCount')}
            </th>
            <th className="cursor-pointer select-none" onClick={() => toggleSort('avgOutputSize')}>
              Avg Output{sortIndicator('avgOutputSize')}
            </th>
            <th>Rate Limits</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((agent) => {
            const color = colorIndex.get(agent.agentName) ?? AGENT_PALETTE[0];
            const errColor = errorRateColor(agent.errorRate);
            const invPct = (agent.invocations / maxInvocations) * 100;
            const topSource = Object.entries(agent.sourceTypes).sort((a, b) => b[1] - a[1])[0]?.[0];
            const isExpanded = expanded === agent.agentName;
            const hasLinks = agent.sessionIds.length > 0 || agent.traceIds.length > 0;

            return (
              <Fragment key={agent.agentName}>
                <tr
                  className={`valign-middle${isExpanded ? ' eval-row-expanded' : ''}`}
                  style={{ cursor: hasLinks ? 'pointer' : undefined }}
                  onClick={() => hasLinks && setExpanded(isExpanded ? null : agent.agentName)}
                >
                  {/* Agent name with color accent */}
                  <td>
                    <div className="flex-center gap-2">
                      {hasLinks && (
                        <ExpandChevron expanded={isExpanded} className="text-2xs text-muted shrink-0" />
                      )}
                      <span className="dot-sm" style={{ background: color }} />
                      <span className="mono-xs text-primary break-all">
                        {agent.agentName}
                      </span>
                    </div>
                  </td>

                  {/* Invocations with inline bar */}
                  <td>
                    <div className="flex-center gap-2">
                      <span className="mono-xs" style={{ minWidth: 'var(--space-8)' }}>
                        {agent.invocations}
                      </span>
                      <BarIndicator value={invPct} color={color} opacity={0.7} className="flex-1" style={{ minWidth: AGENT_BAR_MIN_WIDTH }} />
                    </div>
                  </td>

                  {/* Error rate */}
                  <td>
                    <div className="flex-center gap-1-5">
                      <span className="mono-xs" style={{
                        color: errColor,
                      }}>
                        {agent.errors > 0 ? formatPercent(agent.errorRate * 100) : '\u2014'}
                      </span>
                      {agent.errors > 0 && (
                        <span className="text-muted text-xs">
                          ({agent.errors})
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Session count */}
                  <td>
                    <span className="mono-xs">
                      {agent.sessionCount}
                    </span>
                  </td>

                  {/* Avg output size */}
                  <td>
                    <span className="mono-xs text-secondary">
                      {fmtBytes(agent.avgOutputSize)}
                    </span>
                  </td>

                  {/* Rate limits */}
                  <td>
                    {agent.rateLimitCount > 0 ? (
                      <span className="mono-xs badge-warning">
                        {agent.rateLimitCount}x
                      </span>
                    ) : (
                      <span className="text-muted text-xs">{'\u2014'}</span>
                    )}
                  </td>

                  {/* Source type */}
                  <td>
                    {topSource ? (
                      <span className="mono text-muted text-2xs uppercase">
                        {topSource}
                      </span>
                    ) : <span className="text-muted">{'\u2014'}</span>}
                  </td>
                </tr>

                {/* Expanded row: eval summary + sessions + traces */}
                {isExpanded && (
                  <tr className="eval-expanded-panel">
                    <td colSpan={COLUMN_COUNT} className="border-b">
                      {/* Evaluation summary */}
                      <EvalSummaryRow evalSummary={agent.evalSummary} />

                      {/* Daily invocation sparkline */}
                      {agent.dailyCounts.length > 1 && agent.dailyCounts.some(v => v > 0) && (
                        <div className="border-b-subtle mb-1 pad-panel-section">
                          <div className="flex-center gap-3">
                            <div className="text-xs text-muted uppercase shrink-0">
                              Daily Activity
                            </div>
                            <Sparkline
                              data={agent.dailyCounts}
                              width={SPARKLINE_WIDTH}
                              height={SPARKLINE_HEIGHT}
                              color={colorIndex.get(agent.agentName) ?? AGENT_PALETTE[0]}
                              label={`Daily invocations for ${agent.agentName}`}
                            />
                            <span className="mono text-muted text-2xs shrink-0">
                              peak {Math.max(...agent.dailyCounts)}/day
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="agent-expanded-grid">
                        {/* Sessions column */}
                        <div>
                          <div className="text-muted mb-1-5 text-xs uppercase">
                            Sessions ({agent.sessionCount})
                          </div>
                          <div className="flex-col gap-1">
                            {agent.sessionIds.map(sid => (
                              <TruncatedIdLink
                                key={sid}
                                id={sid}
                                href={routes.session(sid)}
                                maxLen={12}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ))}
                            {agent.sessionIds.length === 0 && (
                              <span className="text-muted text-xs">none</span>
                            )}
                            {/* sessionCount === total unique sessions; sessionIds is capped at 50 */}
                            {agent.sessionIdsTruncated && (
                              <span className="text-muted text-2xs italic">
                                +{agent.sessionCount - agent.sessionIds.length} more
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Traces column */}
                        <div>
                          <div className="text-muted mb-1-5 text-xs uppercase">
                            Traces ({agent.traceIdsTotal ?? agent.traceIds.length})
                          </div>
                          <div className="flex-col gap-1">
                            {agent.traceIds.map(tid => (
                              <TruncatedIdLink
                                key={tid}
                                id={tid}
                                href={routes.trace(tid)}
                                maxLen={12}
                                onClick={(e) => e.stopPropagation()}
                              />
                            ))}
                            {agent.traceIds.length === 0 && (
                              <span className="text-muted text-xs">none</span>
                            )}
                            {agent.traceIdsTruncated && (
                              <span className="text-muted text-2xs italic">
                                +{(agent.traceIdsTotal ?? 0) - agent.traceIds.length} more
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Per-agent evaluation metrics (relevance, coherence, faithfulness, etc.) */
function EvalSummaryRow({ evalSummary }: { evalSummary: Record<string, EvalMetricSummary> }) {
  const metrics = Object.entries(evalSummary);
  if (metrics.length === 0) {
    return (
      <div className="text-xs text-muted border-b-subtle mb-1 pad-panel-sparse">
        No evaluations linked to this agent.
      </div>
    );
  }

  return (
    <div className="border-b-subtle mb-1 pad-panel-section">
      <div className="text-muted mb-1-5 text-xs uppercase">
        Evaluation Metrics
      </div>
      <div className="flex-wrap gap-3">
        {metrics.map(([name, m]) => {
          const barColor = scoreColor(m.avg);
          return (
            <div key={name} className="metric-card-compact" style={{ minWidth: AGENT_EVAL_CARD_MIN_WIDTH }}>
              <div className="text-secondary mb-1 text-xs truncate">
                {name}
              </div>
              <div className="flex-center mb-1 gap-2">
                <BarIndicator value={Math.min(m.avg * 100, 100)} color={barColor} className="flex-1" />
                <span className="mono-xs font-semibold text-right score-label-width" style={{ color: barColor }}>
                  {m.avg.toFixed(2)}
                </span>
              </div>
              {/* Min/max range + count */}
              <div className="mono text-muted flex-wrap justify-between text-2xs">
                <span>{m.min.toFixed(2)}\u2013{m.max.toFixed(2)}</span>
                <span>n={m.count}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Summary bar above the table -- totals at a glance */
export function AgentActivitySummary({ agents }: AgentActivityPanelProps) {
  const totalInvocations = agents.reduce((s, a) => s + a.invocations, 0);
  const totalErrors = agents.reduce((s, a) => s + a.errors, 0);
  const totalRateLimits = agents.reduce((s, a) => s + a.rateLimitCount, 0);
  const rawErrorRate = totalInvocations > 0 ? totalErrors / totalInvocations : 0;
  const overallErrorRate = rawErrorRate * 100;

  return (
    <div className="d-flex flex-wrap gap-8 surface-elevated mb-5 p-4-5">
      {[
        { label: 'Agents', value: agents.length },
        { label: 'Invocations', value: totalInvocations.toLocaleString() },
        {
          label: 'Error Rate',
          value: totalInvocations > 0 ? formatPercent(overallErrorRate) : '\u2014',
          color: errorRateColor(rawErrorRate),
        },
        {
          label: 'Rate Limits',
          value: totalRateLimits > 0 ? totalRateLimits : '\u2014',
          color: totalRateLimits > 0 ? 'var(--status-warning)' : undefined,
        },
      ].map(({ label, value, color }) => (
        <StatDisplay key={label} value={value} label={label} valueColor={color} />
      ))}
    </div>
  );
}
