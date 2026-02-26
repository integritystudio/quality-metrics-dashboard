import { type ReactNode } from 'react';
import { Link } from 'wouter';
import { useSessionDetail } from '../hooks/useSessionDetail.js';
import { EvaluationTable, type EvalRow } from '../components/EvaluationTable.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import type { EvaluationResult } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function shortPath(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : fullPath;
}

function fmtBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function evalToRow(e: EvaluationResult): EvalRow {
  return {
    score: typeof e.scoreValue === 'number' ? e.scoreValue : 0,
    explanation: e.explanation,
    traceId: e.traceId,
    timestamp: e.timestamp,
    evaluator: e.evaluator,
    label: e.scoreLabel,
    evaluatorType: e.evaluatorType,
    spanId: e.spanId,
    sessionId: e.sessionId,
    agentName: e.agentName,
    trajectoryLength: e.trajectoryLength,
    stepScores: e.stepScores as EvalRow['stepScores'],
    toolVerifications: e.toolVerifications as EvalRow['toolVerifications'],
  };
}

function scoreColor(s: number): string {
  if (s >= 0.85) return 'var(--status-healthy)';
  if (s >= 0.65) return 'var(--status-warning)';
  return 'var(--status-critical)';
}

// ─── Section accordion ──────────────────────────────────────────────────────

interface SectionProps {
  title: string;
  badge?: string;
  health?: 'ok' | 'warn' | 'crit' | 'neutral';
  defaultOpen?: boolean;
  children: ReactNode;
}

function Section({ title, badge, health = 'neutral', defaultOpen = false, children }: SectionProps) {
  const railColor = health === 'ok'
    ? 'var(--status-healthy)'
    : health === 'warn'
    ? 'var(--status-warning)'
    : health === 'crit'
    ? 'var(--status-critical)'
    : 'var(--border-accent)';

  return (
    <details open={defaultOpen} style={{ marginBottom: 2 }}>
      <summary style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 20px',
        background: 'var(--bg-card)',
        borderLeft: `3px solid ${railColor}`,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        userSelect: 'none',
        listStyle: 'none',
        transition: 'background 0.15s',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: railColor,
          transition: 'transform 0.2s',
          display: 'inline-block',
        }}>▶</span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          flex: 1,
        }}>{title}</span>
        {badge && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'var(--bg-elevated)',
            padding: '2px 8px',
            borderRadius: 10,
            border: '1px solid var(--border-subtle)',
          }}>{badge}</span>
        )}
      </summary>
      <div style={{
        padding: '16px 20px 20px',
        background: 'var(--bg-card)',
        borderLeft: `3px solid ${railColor}`,
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        {children}
      </div>
    </details>
  );
}

// ─── Stat chip ───────────────────────────────────────────────────────────────

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ textAlign: 'center', flex: '1 1 100px', minWidth: 80 }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 22,
        fontWeight: 700,
        color: color ?? 'var(--text-primary)',
        lineHeight: 1.1,
      }}>{value}</div>
      <div style={{
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--text-muted)',
        marginTop: 3,
      }}>{label}</div>
    </div>
  );
}

// ─── Frequency bar ───────────────────────────────────────────────────────────

function FreqBar({ label, count, max, color }: { label: string; count: number; max: number; color?: string }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
      <div style={{
        width: 160,
        fontSize: 12,
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-secondary)',
        textAlign: 'right',
        flexShrink: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>{label}</div>
      <div style={{ flex: 1, background: 'var(--bg-elevated)', borderRadius: 2, height: 6, overflow: 'hidden' }}>
        <div style={{
          width: `${pct}%`,
          height: '100%',
          background: color ?? 'var(--accent)',
          borderRadius: 2,
          transition: 'width 0.4s ease',
        }} />
      </div>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-muted)',
        width: 36,
        textAlign: 'right',
        flexShrink: 0,
      }}>{count}</div>
    </div>
  );
}

// ─── Issue callout ───────────────────────────────────────────────────────────

function IssueCallout({ severity, title, children }: {
  severity: 'warning' | 'critical';
  title: string;
  children: ReactNode;
}) {
  const color = severity === 'critical' ? 'var(--status-critical)' : 'var(--status-warning)';
  return (
    <div style={{
      borderLeft: `3px solid ${color}`,
      background: severity === 'critical' ? 'rgba(240,68,56,0.06)' : 'rgba(229,160,13,0.06)',
      borderRadius: '0 var(--radius) var(--radius) 0',
      padding: '10px 14px',
      marginBottom: 10,
    }}>
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color,
        marginBottom: 4,
      }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        {children}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useSessionDetail(sessionId);

  if (isLoading) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="card skeleton" style={{ height: 120, marginBottom: 2 }} />
        <div className="card skeleton" style={{ height: 56, marginBottom: 2 }} />
        <div className="card skeleton" style={{ height: 200, marginBottom: 2 }} />
        <div className="card skeleton" style={{ height: 160 }} />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link href="/" className="back-link">&larr; Back to dashboard</Link>
        <div className="error-state"><h2>Failed to load session</h2><p>{error.message}</p></div>
      </div>
    );
  }

  if (!data) return null;

  const {
    sessionInfo, toolUsage, mcpUsage, agentActivity, fileAccess,
    gitCommits, tokenProgression, spanBreakdown, alertSummary,
    codeStructure, errors, evaluation, evaluations, spans,
  } = data;

  // Derive computed values
  const totalToolCalls = Object.values(toolUsage).reduce((a, b) => a + b, 0);
  const totalMcpCalls = Object.values(mcpUsage).reduce((a, b) => a + b, 0);
  const maxTokenSnapshot = tokenProgression.at(-1);
  const maxToolCount = Math.max(...Object.values(toolUsage), 1);
  const maxMcpCount = Math.max(...Object.values(mcpUsage), 1);
  const maxFileCount = fileAccess[0]?.count ?? 1;
  const maxSpanCount = Math.max(...Object.values(spanBreakdown), 1);

  // Issue detection
  const hallucinationEvals = evaluations.filter(e =>
    (e.evaluationName ?? '').toLowerCase().includes('hallucin') ||
    ((e.scoreLabel ?? '').toLowerCase() === 'fail' && typeof e.scoreValue === 'number' && e.scoreValue < 0.4)
  );
  const failedEvals = evaluations.filter(e =>
    (e.scoreLabel ?? '').toLowerCase() === 'fail'
  );
  const hasIssues = alertSummary.totalFired > 0 || errors.length > 0 ||
    hallucinationEvals.length > 0 || failedEvals.length > 0;
  const issueHealth: SectionProps['health'] = errors.length > 0 || hallucinationEvals.length > 0
    ? 'crit'
    : alertSummary.totalFired > 0 || failedEvals.length > 0
    ? 'warn'
    : 'ok';

  // Score interpretation
  const handoffScore = evaluation.handoffScore ?? 0;
  const avgRelevance = evaluation.avgTurnRelevance ?? 0;
  const completeness = evaluation.conversationCompleteness ?? 0;
  const evalRows: EvalRow[] = evaluations.map(evalToRow);

  // Unique models used
  const models = [...new Set(tokenProgression.map(t => t.model).filter(Boolean))];

  return (
    <div style={{ maxWidth: 1100 }}>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>

      {/* ── Header ── */}
      <div style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border-subtle)',
        borderBottom: 'none',
        padding: '20px 24px 16px',
        marginBottom: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              letterSpacing: '0.15em',
              textTransform: 'uppercase',
              color: 'var(--text-muted)',
              marginBottom: 6,
            }}>Session Detail</div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 15,
              fontWeight: 600,
              color: 'var(--accent-hover)',
              letterSpacing: '0.02em',
              marginBottom: 8,
              wordBreak: 'break-all',
            }}>{sessionId}</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-secondary)' }}>
              <span>{sessionInfo.projectName}</span>
              {sessionInfo.gitRepository && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {sessionInfo.gitRepository}
                  {sessionInfo.gitBranch ? ` · ${sessionInfo.gitBranch}` : ''}
                </span>
              )}
              {sessionInfo.resumeCount > 1 && (
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  background: 'var(--accent-muted)',
                  color: 'var(--accent-hover)',
                  padding: '2px 8px',
                  borderRadius: 10,
                  letterSpacing: '0.05em',
                }}>RESUMED ×{sessionInfo.resumeCount}</span>
              )}
              {models.map(m => (
                <span key={m} style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  background: 'var(--bg-elevated)',
                  color: 'var(--text-muted)',
                  padding: '2px 8px',
                  borderRadius: 10,
                  border: '1px solid var(--border-subtle)',
                }}>{m}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Vitals strip ── */}
      <div style={{
        display: 'flex',
        gap: 0,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderBottom: '1px solid var(--border)',
        padding: '14px 24px',
        flexWrap: 'wrap',
        rowGap: 12,
        marginBottom: 2,
      }}>
        <Stat label="Spans" value={spans.length} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        <Stat label="Tool calls" value={totalToolCalls} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        <Stat label="MCP calls" value={totalMcpCalls} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        <Stat label="Commits" value={gitCommits.length} color={gitCommits.length > 0 ? 'var(--status-healthy)' : undefined} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        <Stat label="Alerts fired" value={alertSummary.totalFired} color={alertSummary.totalFired > 0 ? 'var(--status-warning)' : undefined} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        <Stat label="Errors" value={errors.length} color={errors.length > 0 ? 'var(--status-critical)' : undefined} />
        <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
        {maxTokenSnapshot && (
          <Stat label="Messages" value={maxTokenSnapshot.messages} />
        )}
        {maxTokenSnapshot && (
          <>
            <div style={{ width: 1, background: 'var(--border-subtle)', margin: '0 8px', alignSelf: 'stretch' }} />
            <Stat label="Output tokens" value={fmtBytes(maxTokenSnapshot.outputTokens)} />
          </>
        )}
      </div>

      {/* ── Issues & Anomalies ── */}
      <Section
        title="Issues & Anomalies"
        badge={hasIssues ? `${[
          alertSummary.totalFired > 0 && `${alertSummary.totalFired} alerts`,
          errors.length > 0 && `${errors.length} errors`,
          hallucinationEvals.length > 0 && `${hallucinationEvals.length} hallucinations`,
          failedEvals.length > 0 && `${failedEvals.length} failures`,
        ].filter(Boolean).join(' · ')}` : 'clean'}
        health={issueHealth}
        defaultOpen={hasIssues}
      >
        {!hasIssues && (
          <div style={{ color: 'var(--status-healthy)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            No issues detected in this session.
          </div>
        )}

        {alertSummary.totalFired > 0 && (
          <IssueCallout severity="warning" title={`${alertSummary.totalFired} alert${alertSummary.totalFired !== 1 ? 's' : ''} fired across ${alertSummary.stopEvents} stop event${alertSummary.stopEvents !== 1 ? 's' : ''}`}>
            <strong>task-completion-low</strong> — The task completion ratio fell below 0.85.
            This fires when tasks are created but not marked complete before the session ends.
            Common causes: work deferred to backlog, sub-tasks spawned but not resolved,
            or tasks marked in-progress but not completed within the session.
          </IssueCallout>
        )}

        {errors.length > 0 && (
          <IssueCallout severity="critical" title={`${errors.length} error span${errors.length !== 1 ? 's' : ''}`}>
            <div style={{ marginBottom: 8 }}>Tool invocations or agent calls that reported errors:</div>
            {errors.slice(0, 10).map((e, i) => (
              <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: 'var(--status-critical)' }}>✗</span>{' '}
                {e.spanName}{e.tool ? ` (${e.tool})` : ''}{e.filePath ? ` · ${shortPath(e.filePath)}` : ''}
                {e.statusMessage && <span style={{ color: 'var(--text-muted)' }}> — {e.statusMessage}</span>}
              </div>
            ))}
            {errors.length > 10 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 4 }}>
                +{errors.length - 10} more
              </div>
            )}
          </IssueCallout>
        )}

        {hallucinationEvals.length > 0 && (
          <IssueCallout severity="critical" title={`${hallucinationEvals.length} hallucination indicator${hallucinationEvals.length !== 1 ? 's' : ''} detected`}>
            <div style={{ marginBottom: 8 }}>
              Evaluations flagging potential hallucination or very low confidence:
            </div>
            {hallucinationEvals.slice(0, 8).map((e, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <ScoreBadge score={typeof e.scoreValue === 'number' ? e.scoreValue : 0} metricName={e.evaluationName ?? 'hallucination'} />
                <div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.evaluationName}</div>
                  {e.explanation && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                      {e.explanation.slice(0, 200)}{e.explanation.length > 200 ? '…' : ''}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </IssueCallout>
        )}

        {failedEvals.length > 0 && !hallucinationEvals.length && (
          <IssueCallout severity="warning" title={`${failedEvals.length} evaluation${failedEvals.length !== 1 ? 's' : ''} marked fail`}>
            {failedEvals.slice(0, 6).map((e, i) => (
              <div key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginBottom: 3 }}>
                <span style={{ color: 'var(--status-warning)' }}>⚠</span>{' '}
                {e.evaluationName} — score {typeof e.scoreValue === 'number' ? e.scoreValue.toFixed(3) : 'N/A'}
              </div>
            ))}
          </IssueCallout>
        )}

        {evaluation.errorPropagationTurns > 0 && (
          <IssueCallout severity="warning" title={`${evaluation.errorPropagationTurns} error propagation turn${evaluation.errorPropagationTurns !== 1 ? 's' : ''}`}>
            Errors detected in the multi-agent turn sequence may have propagated across agent handoffs.
          </IssueCallout>
        )}
      </Section>

      {/* ── Token Journey ── */}
      <Section
        title="Token Journey"
        badge={maxTokenSnapshot ? `${maxTokenSnapshot.messages} msg · ${fmtBytes(maxTokenSnapshot.outputTokens)} out` : 'no data'}
        health="neutral"
      >
        {tokenProgression.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No token snapshots recorded.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)', fontSize: 12,
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Messages', 'Input', 'Output', 'Cache Read', 'Cache Create', 'Model'].map(h => (
                    <th key={h} style={{ padding: '6px 12px', textAlign: 'right', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.05em', whiteSpace: 'nowrap' }}>
                      {h.toUpperCase()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tokenProgression.map((t, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '5px 12px', textAlign: 'right' }}>{t.messages}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--text-secondary)' }}>{fmtBytes(t.inputTokens)}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--accent-hover)' }}>{fmtBytes(t.outputTokens)}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtBytes(t.cacheRead)}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{fmtBytes(t.cacheCreation)}</td>
                    <td style={{ padding: '5px 12px', textAlign: 'right', color: 'var(--text-muted)' }}>{t.model}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ── Tool Activity ── */}
      <Section
        title="Tool Activity"
        badge={`${totalToolCalls} calls · ${Object.keys(toolUsage).length} tools`}
        health="neutral"
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '0 32px' }}>
          {Object.entries(toolUsage)
            .sort((a, b) => b[1] - a[1])
            .map(([tool, count]) => (
              <FreqBar key={tool} label={tool} count={count} max={maxToolCount} />
            ))
          }
        </div>

        {totalMcpCalls > 0 && (
          <>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-muted)', margin: '14px 0 8px' }}>
              MCP Tools — {totalMcpCalls} calls
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '0 32px' }}>
              {Object.entries(mcpUsage)
                .sort((a, b) => b[1] - a[1])
                .map(([tool, count]) => (
                  <FreqBar key={tool} label={tool} count={count} max={maxMcpCount} color="var(--status-healthy)" />
                ))
              }
            </div>
          </>
        )}
      </Section>

      {/* ── Agent Activity ── */}
      {agentActivity.length > 0 && (
        <Section
          title="Agent Activity"
          badge={agentActivity.map(a => `${a.agentName} ×${a.invocations}`).join(' · ')}
          health={agentActivity.some(a => a.errors > 0) ? 'warn' : 'neutral'}
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
            {agentActivity.map(a => (
              <div key={a.agentName} style={{
                background: 'var(--bg-elevated)',
                border: `1px solid ${a.errors > 0 ? 'var(--status-warning)' : 'var(--border-subtle)'}`,
                borderRadius: 'var(--radius)',
                padding: '10px 14px',
              }}>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  {a.agentName}
                </div>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>{a.invocations}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>invocations</div>
                  </div>
                  {a.errors > 0 && (
                    <div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--status-warning)' }}>{a.errors}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>errors</div>
                    </div>
                  )}
                  <div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700 }}>{fmtBytes(a.avgOutputSize)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>avg output</div>
                  </div>
                </div>
                {a.hasRateLimit && (
                  <div style={{ marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--status-warning)' }}>
                    ⚠ Hit rate limit
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Multi-agent evaluation scores */}
          <div style={{ marginTop: 16, display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {[
              { label: 'Handoff Score', value: handoffScore },
              { label: 'Avg Relevance', value: avgRelevance },
              { label: 'Completeness', value: completeness },
            ].map(({ label, value }) => (
              <div key={label} style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
                <ScoreBadge score={value} metricName={label.toLowerCase()} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Files Accessed ── */}
      {fileAccess.length > 0 && (
        <Section
          title="Files Accessed"
          badge={`${fileAccess.length} files · top: ${shortPath(fileAccess[0]?.path ?? '')}`}
          health="neutral"
        >
          <div style={{ columns: '2 320px', columnGap: 32 }}>
            {fileAccess.map(({ path, count }) => (
              <div key={path} style={{ breakInside: 'avoid' }}>
                <FreqBar
                  label={shortPath(path)}
                  count={count}
                  max={maxFileCount}
                  color="var(--accent)"
                />
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ── Git Commits ── */}
      {gitCommits.length > 0 && (
        <Section
          title="Git Commits"
          badge={`${gitCommits.length} commit${gitCommits.length !== 1 ? 's' : ''}`}
          health="ok"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {gitCommits.map((commit, i) => (
              <details key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <summary style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 4px',
                  cursor: 'pointer',
                  listStyle: 'none',
                }}>
                  <span style={{ color: 'var(--status-healthy)', fontSize: 10, flexShrink: 0 }}>●</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, flex: 1 }}>
                    {commit.subject}
                  </span>
                  {commit.files && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>
                      {commit.files.split(' ').length} file{commit.files.split(' ').length !== 1 ? 's' : ''}
                    </span>
                  )}
                </summary>
                <div style={{ paddingLeft: 20, paddingBottom: 10 }}>
                  {commit.body && (
                    <div style={{
                      fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 8,
                      fontFamily: 'var(--font-body)',
                    }}>
                      {commit.body}
                    </div>
                  )}
                  {commit.files && (
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-muted)' }}>
                      {commit.files.split(' ').map((f, fi) => (
                        <div key={fi}>{shortPath(f)}</div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            ))}
          </div>
        </Section>
      )}

      {/* ── Code Quality ── */}
      {codeStructure.length > 0 && (
        <Section
          title="Code Quality"
          badge={`${codeStructure.length} file${codeStructure.length !== 1 ? 's' : ''} analyzed`}
          health={codeStructure.some(f => f.score < 0.6) ? 'warn' : 'ok'}
        >
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['File', 'Tool', 'Lines', 'Exports', 'Functions', 'Types', 'Score'].map(h => (
                    <th key={h} style={{ padding: '5px 10px', textAlign: h === 'File' || h === 'Tool' ? 'left' : 'right', color: 'var(--text-muted)', fontWeight: 500, letterSpacing: '0.05em' }}>
                      {h.toUpperCase()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {codeStructure.map((f, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ padding: '5px 10px', color: 'var(--text-secondary)' }}>{shortPath(f.file)}</td>
                    <td style={{ padding: '5px 10px', color: 'var(--text-muted)' }}>{f.tool}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>{f.lines}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{f.exports}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-muted)' }}>{f.functions}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'center' }}>{f.hasTypes ? '✓' : '·'}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color: scoreColor(f.score) }}>
                      {f.score.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* ── Span Breakdown ── */}
      <Section
        title="Span Breakdown"
        badge={`${spans.length} total · ${Object.keys(spanBreakdown).length} types`}
        health="neutral"
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '0 32px' }}>
          {Object.entries(spanBreakdown)
            .sort((a, b) => b[1] - a[1])
            .map(([name, count]) => (
              <FreqBar key={name} label={name} count={count} max={maxSpanCount} color="var(--border-accent)" />
            ))
          }
        </div>
      </Section>

      {/* ── Evaluations ── */}
      <Section
        title="Evaluations"
        badge={evalRows.length > 0 ? `${evalRows.length} result${evalRows.length !== 1 ? 's' : ''}` : 'none'}
        health={hallucinationEvals.length > 0 ? 'crit' : failedEvals.length > 0 ? 'warn' : evalRows.length > 0 ? 'ok' : 'neutral'}
      >
        {evalRows.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            No evaluations recorded for this session.
          </div>
        ) : (
          <EvaluationTable evaluations={evalRows} />
        )}
      </Section>
    </div>
  );
}
