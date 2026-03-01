import { Fragment, useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { AgentStat, EvalMetricSummary } from '../hooks/useAgentStats.js';
import { scoreColorBand, SCORE_COLORS, truncateId } from '../lib/quality-utils.js';
import { AGENT_PALETTE, ERROR_RATE_WARNING_THRESHOLD } from '../lib/constants.js';
import { Sparkline } from './Sparkline.js';

const COLUMN_COUNT = 7;
const RATE_LIMIT_BADGE_BG = 'var(--bg-status-warning)';

type SortKey = 'invocations' | 'errorRate' | 'sessionCount' | 'avgOutputSize';

function errorRateColor(rate: number): string {
  if (rate === 0) return 'var(--status-healthy)';
  if (rate < ERROR_RATE_WARNING_THRESHOLD) return 'var(--status-warning)';
  return 'var(--status-critical)';
}

function formatBytes(n: number): string {
  if (n === 0) return '\u2014';
  if (n < 1024) return `${n}B`;
  return `${(n / 1024).toFixed(1)}K`;
}

interface AgentActivityPanelProps {
  agents: AgentStat[];
}

export function AgentActivityPanel({ agents }: AgentActivityPanelProps) {
  const [sort, setSort] = useState<SortKey>('invocations');
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const colorIndex = useMemo(
    () => new Map(agents.map((a, i) => [a.agentName, AGENT_PALETTE[i % AGENT_PALETTE.length]])),
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
    return (
      <div className="text-muted" style={{ padding: '32px 0', textAlign: 'center' }}>
        No agent activity recorded for this period.
      </div>
    );
  }

  const maxInvocations = Math.max(...agents.map(a => a.invocations), 1);

  const sorted = [...agents].sort((a, b) => {
    const diff = a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0;
    return asc ? diff : -diff;
  });

  const sortIndicator = (key: SortKey) =>
    sort === key ? (asc ? ' \u2191' : ' \u2193') : '';

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sla-table" style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Agent</th>
            <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('invocations')}>
              Invocations{sortIndicator('invocations')}
            </th>
            <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('errorRate')}>
              Error Rate{sortIndicator('errorRate')}
            </th>
            <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('sessionCount')}>
              Sessions{sortIndicator('sessionCount')}
            </th>
            <th style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => toggleSort('avgOutputSize')}>
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
                  className={isExpanded ? 'eval-row-expanded' : ''}
                  style={{ verticalAlign: 'middle', cursor: hasLinks ? 'pointer' : undefined }}
                  onClick={() => hasLinks && setExpanded(isExpanded ? null : agent.agentName)}
                >
                  {/* Agent name with color accent */}
                  <td>
                    <div className="flex-center gap-2">
                      {hasLinks && (
                        <span style={{
                          fontSize: 'var(--font-size-2xs)',
                          color: 'var(--text-muted)',
                          transition: 'transform 0.15s',
                          transform: isExpanded ? 'rotate(90deg)' : 'none',
                          flexShrink: 0,
                        }}>
                          &#9654;
                        </span>
                      )}
                      <span style={{
                        display: 'inline-block',
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: color,
                        flexShrink: 0,
                      }} />
                      <span className="mono-xs" style={{
                        color: 'var(--text-primary)',
                        wordBreak: 'break-all',
                      }}>
                        {agent.agentName}
                      </span>
                    </div>
                  </td>

                  {/* Invocations with inline bar */}
                  <td>
                    <div className="flex-center gap-2">
                      <span className="mono-xs" style={{ minWidth: 32 }}>
                        {agent.invocations}
                      </span>
                      <div className="mini-bar" style={{ flex: 1, minWidth: 48 }}>
                        <div className="mini-bar-fill" style={{ width: `${invPct}%`, background: color, opacity: 0.7 }} />
                      </div>
                    </div>
                  </td>

                  {/* Error rate */}
                  <td>
                    <div className="flex-center gap-1-5">
                      <span className="mono-xs" style={{
                        color: errColor,
                      }}>
                        {agent.errors > 0 ? `${(agent.errorRate * 100).toFixed(1)}%` : '\u2014'}
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
                      {formatBytes(agent.avgOutputSize)}
                    </span>
                  </td>

                  {/* Rate limits */}
                  <td>
                    {agent.rateLimitCount > 0 ? (
                      <span className="mono-xs" style={{
                        color: 'var(--status-warning)',
                        background: RATE_LIMIT_BADGE_BG,
                        padding: '1px 6px',
                        borderRadius: 10,
                      }}>
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
                    <td colSpan={COLUMN_COUNT} style={{ padding: '0 10px 10px', borderBottom: '1px solid var(--border)' }}>
                      {/* Evaluation summary */}
                      <EvalSummaryRow evalSummary={agent.evalSummary} />

                      {/* Daily invocation sparkline */}
                      {agent.dailyCounts.length > 1 && agent.dailyCounts.some(v => v > 0) && (
                        <div style={{
                          padding: '10px 0 8px',
                          borderBottom: '1px solid var(--border-subtle)',
                          marginBottom: 4,
                        }}>
                          <div className="flex-center gap-3">
                            <div className="text-xs text-muted uppercase" style={{
                              flexShrink: 0,
                            }}>
                              Daily Activity
                            </div>
                            <Sparkline
                              data={agent.dailyCounts}
                              width={160}
                              height={28}
                              color={colorIndex.get(agent.agentName) ?? AGENT_PALETTE[0]}
                              label={`Daily invocations for ${agent.agentName}`}
                            />
                            <span className="mono text-muted" style={{
                              fontSize: 'var(--font-size-2xs)',
                              flexShrink: 0,
                            }}>
                              peak {Math.max(...agent.dailyCounts)}/day
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="gap-4" style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        padding: '12px 0 4px',
                      }}>
                        {/* Sessions column */}
                        <div>
                          <div className="text-muted mb-1-5 text-xs uppercase">
                            Sessions ({agent.sessionCount})
                          </div>
                          <div className="gap-1" style={{ display: 'flex', flexDirection: 'column' }}>
                            {agent.sessionIds.map(sid => (
                              <Link
                                key={sid}
                                href={`/sessions/${sid}`}
                                className="mono-xs"
                                style={{
                                  color: 'var(--accent)',
                                  textDecoration: 'none',
                                }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {truncateId(sid, 12)}
                              </Link>
                            ))}
                            {agent.sessionIds.length === 0 && (
                              <span className="text-muted text-xs">none</span>
                            )}
                            {/* sessionCount === total unique sessions; sessionIds is capped at 50 */}
                            {agent.sessionIdsTruncated && (
                              <span className="text-muted" style={{ fontSize: 'var(--font-size-2xs)', fontStyle: 'italic' }}>
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
                          <div className="gap-1" style={{ display: 'flex', flexDirection: 'column' }}>
                            {agent.traceIds.map(tid => (
                              <Link
                                key={tid}
                                href={`/traces/${tid}`}
                                className="mono-xs"
                                style={{
                                  color: 'var(--accent)',
                                  textDecoration: 'none',
                                }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {truncateId(tid, 12)}
                              </Link>
                            ))}
                            {agent.traceIds.length === 0 && (
                              <span className="text-muted text-xs">none</span>
                            )}
                            {agent.traceIdsTruncated && (
                              <span className="text-muted" style={{ fontSize: 'var(--font-size-2xs)', fontStyle: 'italic' }}>
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
      <div style={{
        padding: '10px 0 4px',
        fontSize: 12,
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border-subtle)',
        marginBottom: 4,
      }}>
        No evaluations linked to this agent.
      </div>
    );
  }

  return (
    <div style={{
      padding: '10px 0 8px',
      borderBottom: '1px solid var(--border-subtle)',
      marginBottom: 4,
    }}>
      <div className="text-muted mb-1-5 text-xs uppercase">
        Evaluation Metrics
      </div>
      <div className="gap-3" style={{ display: 'flex', flexWrap: 'wrap' }}>
        {metrics.map(([name, m]) => {
          const band = scoreColorBand(m.avg);
          const barColor = SCORE_COLORS[band];
          return (
            <div key={name} style={{
              minWidth: 140,
              padding: '8px 10px',
              background: 'var(--bg-card)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius)',
            }}>
              <div className="text-secondary mb-1 text-xs" style={{
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {name}
              </div>
              {/* Score bar */}
              <div className="flex-center mb-1 gap-2">
                <div className="mini-bar" style={{ flex: 1 }}>
                  <div className="mini-bar-fill" style={{ width: `${Math.min(m.avg * 100, 100)}%`, background: barColor }} />
                </div>
                <span className="mono-xs font-semibold" style={{
                  color: barColor,
                  minWidth: 38,
                  textAlign: 'right',
                }}>
                  {m.avg.toFixed(2)}
                </span>
              </div>
              {/* Min/max range + count */}
              <div className="mono text-muted" style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 'var(--font-size-2xs)',
              }}>
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
  const overallErrorRate = totalInvocations > 0 ? (totalErrors / totalInvocations) * 100 : 0;

  return (
    <div style={{
      display: 'flex',
      gap: 'var(--space-8)',
      padding: 'var(--space-4) var(--space-5)',
      background: 'var(--bg-elevated)',
      borderRadius: 'var(--radius)',
      border: '1px solid var(--border-subtle)',
      marginBottom: 'var(--space-5)',
      flexWrap: 'wrap',
    }}>
      {[
        { label: 'Agents', value: agents.length },
        { label: 'Invocations', value: totalInvocations.toLocaleString() },
        {
          label: 'Error Rate',
          value: totalInvocations > 0 ? `${overallErrorRate.toFixed(1)}%` : '\u2014',
          color: overallErrorRate === 0
            ? 'var(--status-healthy)'
            : overallErrorRate < ERROR_RATE_WARNING_THRESHOLD * 100
              ? 'var(--status-warning)'
              : 'var(--status-critical)',
        },
        {
          label: 'Rate Limits',
          value: totalRateLimits > 0 ? totalRateLimits : '\u2014',
          color: totalRateLimits > 0 ? 'var(--status-warning)' : undefined,
        },
      ].map(({ label, value, color }) => (
        <div key={label} className="summary-count">
          <div className="value" style={color ? { color } : undefined}>{value}</div>
          <div className="label text-secondary text-xs">{label}</div>
        </div>
      ))}
    </div>
  );
}
