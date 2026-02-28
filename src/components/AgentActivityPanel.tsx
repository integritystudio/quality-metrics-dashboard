import { Fragment, useCallback, useMemo, useState } from 'react';
import { Link } from 'wouter';
import type { AgentStat, EvalMetricSummary } from '../hooks/useAgentStats.js';
import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { Sparkline } from './Sparkline.js';

const AGENT_COLORS = ['#6366f1', '#ec4899', '#14b8a6', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16'];

const COLUMN_COUNT = 7;
const ERROR_RATE_WARNING_THRESHOLD = 0.1;
const RATE_LIMIT_BADGE_BG = '#1f1a0d';

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

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id;
}

interface AgentActivityPanelProps {
  agents: AgentStat[];
}

export function AgentActivityPanel({ agents }: AgentActivityPanelProps) {
  const [sort, setSort] = useState<SortKey>('invocations');
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const colorIndex = useMemo(
    () => new Map(agents.map((a, i) => [a.agentName, AGENT_COLORS[i % AGENT_COLORS.length]])),
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
      <div style={{ padding: '32px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
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
            const color = colorIndex.get(agent.agentName) ?? AGENT_COLORS[0];
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {hasLinks && (
                        <span style={{
                          fontSize: 9,
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
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                        wordBreak: 'break-all',
                      }}>
                        {agent.agentName}
                      </span>
                    </div>
                  </td>

                  {/* Invocations with inline bar */}
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, minWidth: 32 }}>
                        {agent.invocations}
                      </span>
                      <div style={{ flex: 1, height: 4, background: 'var(--bg-surface)', borderRadius: 2, minWidth: 48 }}>
                        <div style={{
                          width: `${invPct}%`,
                          height: '100%',
                          background: color,
                          borderRadius: 2,
                          opacity: 0.7,
                        }} />
                      </div>
                    </div>
                  </td>

                  {/* Error rate */}
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: errColor,
                      }}>
                        {agent.errors > 0 ? `${(agent.errorRate * 100).toFixed(1)}%` : '\u2014'}
                      </span>
                      {agent.errors > 0 && (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                          ({agent.errors})
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Session count */}
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {agent.sessionCount}
                    </span>
                  </td>

                  {/* Avg output size */}
                  <td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
                      {formatBytes(agent.avgOutputSize)}
                    </span>
                  </td>

                  {/* Rate limits */}
                  <td>
                    {agent.rateLimitCount > 0 ? (
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--status-warning)',
                        background: RATE_LIMIT_BADGE_BG,
                        padding: '1px 6px',
                        borderRadius: 10,
                      }}>
                        {agent.rateLimitCount}x
                      </span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{'\u2014'}</span>
                    )}
                  </td>

                  {/* Source type */}
                  <td>
                    {topSource ? (
                      <span style={{
                        fontSize: 10,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}>
                        {topSource}
                      </span>
                    ) : <span style={{ color: 'var(--text-muted)' }}>{'\u2014'}</span>}
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
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                          }}>
                            <div style={{
                              fontSize: 11,
                              color: 'var(--text-muted)',
                              textTransform: 'uppercase',
                              letterSpacing: '0.5px',
                              flexShrink: 0,
                            }}>
                              Daily Activity
                            </div>
                            <Sparkline
                              data={agent.dailyCounts}
                              width={160}
                              height={28}
                              color={colorIndex.get(agent.agentName) ?? AGENT_COLORS[0]}
                              label={`Daily invocations for ${agent.agentName}`}
                            />
                            <span style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10,
                              color: 'var(--text-muted)',
                              flexShrink: 0,
                            }}>
                              peak {Math.max(...agent.dailyCounts)}/day
                            </span>
                          </div>
                        </div>
                      )}

                      <div style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: 16,
                        padding: '12px 0 4px',
                      }}>
                        {/* Sessions column */}
                        <div>
                          <div style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            marginBottom: 6,
                          }}>
                            Sessions ({agent.sessionCount})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {agent.sessionIds.map(sid => (
                              <Link
                                key={sid}
                                href={`/sessions/${sid}`}
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 11,
                                  color: 'var(--accent)',
                                  textDecoration: 'none',
                                }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {truncateId(sid)}
                              </Link>
                            ))}
                            {agent.sessionIds.length === 0 && (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>none</span>
                            )}
                            {/* sessionCount === total unique sessions; sessionIds is capped at 50 */}
                            {agent.sessionIdsTruncated && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                                +{agent.sessionCount - agent.sessionIds.length} more
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Traces column */}
                        <div>
                          <div style={{
                            fontSize: 11,
                            color: 'var(--text-muted)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.5px',
                            marginBottom: 6,
                          }}>
                            Traces ({agent.traceIds.length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                            {agent.traceIds.map(tid => (
                              <Link
                                key={tid}
                                href={`/traces/${tid}`}
                                style={{
                                  fontFamily: 'var(--font-mono)',
                                  fontSize: 11,
                                  color: 'var(--accent)',
                                  textDecoration: 'none',
                                }}
                                onClick={(e: React.MouseEvent) => e.stopPropagation()}
                              >
                                {truncateId(tid)}
                              </Link>
                            ))}
                            {agent.traceIds.length === 0 && (
                              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>none</span>
                            )}
                            {agent.traceIdsTruncated && (
                              <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic' }}>
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
        fontSize: 11,
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
      <div style={{
        fontSize: 11,
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
        marginBottom: 8,
      }}>
        Evaluation Metrics
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
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
              <div style={{
                fontSize: 11,
                color: 'var(--text-secondary)',
                marginBottom: 4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>
                {name}
              </div>
              {/* Score bar */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <div style={{ flex: 1, height: 4, background: 'var(--bg-surface)', borderRadius: 2 }}>
                  <div style={{
                    width: `${Math.min(m.avg * 100, 100)}%`,
                    height: '100%',
                    background: barColor,
                    borderRadius: 2,
                  }} />
                </div>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  fontWeight: 600,
                  color: barColor,
                  minWidth: 38,
                  textAlign: 'right',
                }}>
                  {m.avg.toFixed(2)}
                </span>
              </div>
              {/* Min/max range + count */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
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
          <div className="label">{label}</div>
        </div>
      ))}
    </div>
  );
}
