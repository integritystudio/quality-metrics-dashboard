import { Link } from 'wouter';
import { format } from 'date-fns';
import { useSessionDetail } from '../hooks/useSessionDetail.js';
import { EvaluationTable, evalToRow, type EvalRow } from '../components/EvaluationTable.js';
import { MonoTableHead } from '../components/MonoTableHead.js';
import { ScoreBadge } from '../components/ScoreBadge.js';
import { AgentScoreSummary } from '../components/AgentScoreSummary.js';
import { PageShell } from '../components/PageShell.js';
import { Section, type SectionHealth } from '../components/Section.js';
import { StatDisplay } from '../components/StatDisplay.js';
import { FreqBar } from '../components/FreqBar.js';
import { FreqBarGrid } from '../components/FreqBarGrid.js';
import { TruncatedList } from '../components/TruncatedList.js';
import { IssueCallout } from '../components/IssueCallout.js';
import { SCORE_COLORS, scoreColorBand, shortPath, fmtBytes, truncateText, plural } from '../lib/quality-utils.js';
import {
  HALLUCINATION_SCORE_THRESHOLD,
  MAX_ERROR_ROWS,
  MAX_HALLUCINATION_ROWS,
  MAX_FAILED_EVAL_ROWS,
  SCORE_DISPLAY_PRECISION,
  SKELETON_HEIGHT_LG,
  CALLOUT_MAX_WIDTH,
  PAGE_CONTENT_MAX_WIDTH,
  CODE_QUALITY_WARN_THRESHOLD,
  AGENT_CARD_MIN_WIDTH,
  FILE_ACCESS_COL_MIN,
} from '../lib/constants.js';

// ─── Main page ───────────────────────────────────────────────────────────────

export function SessionDetailPage({ sessionId }: { sessionId: string }) {
  const { data, isLoading, error } = useSessionDetail(sessionId);
  const isNotSynced = !isLoading && error instanceof Error && error.message.startsWith('API error: 404');

  if (isLoading || (!isNotSynced && error)) {
    return <PageShell isLoading={isLoading} error={error ?? null} skeletonHeight={SKELETON_HEIGHT_LG}>{null}</PageShell>;
  }

  if (isNotSynced) {
    return (
      <div>
        <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>
        <div className="card card-spacious text-center">
          <div className="mono-xs mb-1-5 uppercase text-warning">Session Not Yet Available</div>
          <div className="mono-xs text-secondary leading-relaxed" style={{
            maxWidth: CALLOUT_MAX_WIDTH,
            margin: '0 auto',
          }}>
            This session has not been synced to the dashboard KV store yet.
            Data is synced periodically &mdash; check back after the next pipeline run.
          </div>
          <div className="mono-xs text-muted mt-3 break-all">{sessionId}</div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const {
    dataSources, sessionInfo, timespan, toolUsage, mcpUsage,
    agentActivity, fileAccess, gitCommits, tokenProgression, spanBreakdown,
    alertSummary, codeStructure, errors,
    multiAgentEvaluation, evaluations,
  } = data;

  const si = sessionInfo ?? {
    projectName: 'unknown', workingDirectory: '', gitRepository: '', gitBranch: '',
    nodeVersion: '', resumeCount: 0, initialMessageCount: 0, initialContextTokens: 0,
    finalMessageCount: 0, taskCount: 0, uncommittedAtStart: 0,
  };
  const spanCount = dataSources.traces.count;
  const errorDetails = errors.details;

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
    ((e.scoreLabel ?? '').toLowerCase() === 'fail' && typeof e.scoreValue === 'number' && e.scoreValue < HALLUCINATION_SCORE_THRESHOLD)
  );
  const failedEvals = evaluations.filter(e =>
    (e.scoreLabel ?? '').toLowerCase() === 'fail'
  );
  const errorCount = errorDetails.length;
  const hasIssues = alertSummary.totalFired > 0 || errorCount > 0 ||
    hallucinationEvals.length > 0 || failedEvals.length > 0;
  let issueHealth: SectionHealth = 'ok';
  if (errorCount > 0 || hallucinationEvals.length > 0) issueHealth = 'crit';
  else if (alertSummary.totalFired > 0 || failedEvals.length > 0) issueHealth = 'warn';

  // Score interpretation
  const evaluation = multiAgentEvaluation;
  const handoffScore = evaluation.handoffScore ?? 0;
  const avgRelevance = evaluation.avgTurnRelevance ?? 0;
  const completeness = evaluation.conversationCompleteness ?? 0;
  const evalRows: EvalRow[] = evaluations.map(evalToRow);

  // Unique models used
  const models = [...new Set(tokenProgression.map(t => t.model).filter(Boolean))];

  return (
    <div style={{ maxWidth: PAGE_CONTENT_MAX_WIDTH }}>
      <Link href="/" className="back-link inline-flex-center">&larr; Back to dashboard</Link>

      {/* ── Header ── */}
      <div className="session-detail-header">
        <div className="flex-wrap gap-4 justify-between align-start">
          <div>
            <div className="mono text-muted mb-1-5 text-2xs uppercase">Session Detail</div>
            <div className="mono font-semibold text-base mb-2 break-all text-accent-hover ls-id">{sessionId}</div>
            <div className="text-secondary text-xs flex-wrap gap-4">
              <span>{si.projectName}</span>
              {si.gitRepository && (
                <span className="text-muted">
                  {si.gitRepository}
                  {si.gitBranch ? ` · ${si.gitBranch}` : ''}
                </span>
              )}
              {si.resumeCount > 1 && (
                <span className="mono text-2xs chip chip-accent-muted uppercase">RESUMED ×{si.resumeCount}</span>
              )}
              {agentActivity.length > 1 && (
                <span className="mono text-2xs chip chip-healthy uppercase">MULTI-AGENT ×{agentActivity.length}</span>
              )}
              {models.map(m => (
                <span key={m} className="mono text-2xs text-muted chip chip-badge">{m}</span>
              ))}
            </div>
            {timespan && (
              <div className="text-muted text-xs flex-wrap gap-4 mt-1">
                <span>{format(new Date(timespan.start), 'PPp')}</span>
                <span>&rarr;</span>
                <span>{format(new Date(timespan.end), 'PPp')}</span>
                <span className="mono text-2xs chip chip-badge">{timespan.durationHours}h</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Vitals strip ── */}
      <div className="flex-wrap session-vitals-strip">
        <StatDisplay label="Spans" value={spanCount} />
        <div className="vitals-divider" />
        <StatDisplay label="Tool calls" value={totalToolCalls} />
        <div className="vitals-divider" />
        <StatDisplay label="MCP calls" value={totalMcpCalls} />
        <div className="vitals-divider" />
        <StatDisplay label="Commits" value={gitCommits.length} valueColor={gitCommits.length > 0 ? 'var(--status-healthy)' : undefined} />
        <div className="vitals-divider" />
        <StatDisplay label="Alerts fired" value={alertSummary.totalFired} valueColor={alertSummary.totalFired > 0 ? 'var(--status-warning)' : undefined} />
        <div className="vitals-divider" />
        <StatDisplay label="Errors" value={errorCount} valueColor={errorCount > 0 ? 'var(--status-critical)' : undefined} />
        {maxTokenSnapshot && (
          <>
            <div className="vitals-divider" />
            <StatDisplay label="Messages" value={maxTokenSnapshot.messages} />
            <div className="vitals-divider" />
            <StatDisplay label="Output tokens" value={fmtBytes(maxTokenSnapshot.outputTokens)} />
          </>
        )}
      </div>

      {/* ── Issues & Anomalies ── */}
      <Section
        title="Issues & Anomalies"
        badge={hasIssues ? `${[
          alertSummary.totalFired > 0 && `${alertSummary.totalFired} alerts`,
          errorCount > 0 && `${errorCount} errors`,
          hallucinationEvals.length > 0 && `${hallucinationEvals.length} hallucinations`,
          failedEvals.length > 0 && `${failedEvals.length} failures`,
        ].filter(Boolean).join(' · ')}` : 'clean'}
        health={issueHealth}
        defaultOpen={hasIssues}
      >
        {!hasIssues && (
          <div className="mono-xs text-healthy">
            No issues detected in this session.
          </div>
        )}

        {alertSummary.totalFired > 0 && (
          <IssueCallout severity="warning" title={`${plural(alertSummary.totalFired, 'alert')} fired across ${plural(alertSummary.stopEvents, 'stop event')}`}>
            <strong>task-completion-low</strong> — The task completion ratio fell below 0.85.
            This fires when tasks are created but not marked complete before the session ends.
            Common causes: work deferred to backlog, sub-tasks spawned but not resolved,
            or tasks marked in-progress but not completed within the session.
          </IssueCallout>
        )}

        {errorCount > 0 && (
          <IssueCallout severity="critical" title={plural(errorCount, 'error span')}>
            <div className="mb-2">Tool invocations or agent calls that reported errors:</div>
            <TruncatedList
              items={errorDetails}
              max={MAX_ERROR_ROWS}
              total={errorCount}
              renderItem={(e, i) => (
                <div key={i} className="mono-xs mb-1">
                  <span className="text-critical">✗</span>{' '}
                  {e.spanName}{e.tool ? ` (${e.tool})` : ''}{e.filePath ? ` · ${shortPath(e.filePath)}` : ''}
                  {e.errorType && e.errorType !== 'unknown' && <span className="text-muted"> — {e.errorType}</span>}
                </div>
              )}
            />
          </IssueCallout>
        )}

        {hallucinationEvals.length > 0 && (
          <IssueCallout severity="critical" title={`${plural(hallucinationEvals.length, 'hallucination indicator')} detected`}>
            <div className="mb-2">
              Evaluations flagging potential hallucination or very low confidence:
            </div>
            <TruncatedList
              items={hallucinationEvals}
              max={MAX_HALLUCINATION_ROWS}
              renderItem={(e, i) => (
                <div key={i} className="flex-center gap-2-5 mb-1-5">
                  <ScoreBadge score={typeof e.scoreValue === 'number' ? e.scoreValue : 0} metricName={e.evaluationName ?? 'hallucination'} />
                  <div>
                    <div className="mono-xs">{e.evaluationName}</div>
                    {e.explanation && (
                      <div className="text-muted text-xs mt-0-5">
                        {truncateText(e.explanation, 200)}
                      </div>
                    )}
                  </div>
                </div>
              )}
            />
          </IssueCallout>
        )}

        {failedEvals.length > 0 && !hallucinationEvals.length && (
          <IssueCallout severity="warning" title={`${plural(failedEvals.length, 'evaluation')} marked fail`}>
            <TruncatedList
              items={failedEvals}
              max={MAX_FAILED_EVAL_ROWS}
              renderItem={(e, i) => (
                <div key={i} className="mono-xs mb-1">
                  <span className="text-warning">⚠</span>{' '}
                  {e.evaluationName} — score {typeof e.scoreValue === 'number' ? e.scoreValue.toFixed(SCORE_DISPLAY_PRECISION) : 'N/A'}
                </div>
              )}
            />
          </IssueCallout>
        )}

        {evaluation.errorPropagationTurns > 0 && (
          <IssueCallout severity="warning" title={plural(evaluation.errorPropagationTurns, 'error propagation turn')}>
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
          <div className="text-muted text-xs">No token snapshots recorded.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="mono-xs w-full table-collapse">
              <MonoTableHead columns={[
                { label: 'Messages' }, { label: 'Input' }, { label: 'Output' },
                { label: 'Cache Read' }, { label: 'Cache Create' }, { label: 'Model' },
              ]} />
              <tbody>
                {tokenProgression.map((t) => (
                  <tr key={`${t.messages}-${t.model}`} className="border-b-subtle">
                    <td className="cell-pad-wide text-right">{t.messages}</td>
                    <td className="cell-pad-wide text-right text-secondary">{fmtBytes(t.inputTokens)}</td>
                    <td className="cell-pad-wide text-right text-accent-hover">{fmtBytes(t.outputTokens)}</td>
                    <td className="cell-pad-wide text-right text-muted">{fmtBytes(t.cacheRead)}</td>
                    <td className="cell-pad-wide text-right text-muted">{fmtBytes(t.cacheCreation)}</td>
                    <td className="cell-pad-wide text-right text-muted">{t.model}</td>
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
        <FreqBarGrid entries={Object.entries(toolUsage)} max={maxToolCount} />

        {totalMcpCalls > 0 && (
          <>
            <div className="stat-label stat-label-section">
              MCP Tools — {totalMcpCalls} calls
            </div>
            <FreqBarGrid entries={Object.entries(mcpUsage)} max={maxMcpCount} color="var(--status-healthy)" />
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
          <div className="d-grid gap-2-5" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${AGENT_CARD_MIN_WIDTH}, 1fr))` }}>
            {agentActivity.map(a => (
              <div key={a.agentName} className="agent-stat-card" data-has-error={a.errors > 0 ? 'true' : undefined}>
                <div className="mono-xs mb-1-5 font-semibold">
                  {a.agentName}
                </div>
                <div className="flex-wrap gap-3">
                  <div>
                    <div className="mono text-md font-bold">{a.invocations}</div>
                    <div className="stat-label">invocations</div>
                  </div>
                  {a.errors > 0 && (
                    <div>
                      <div className="mono text-md font-bold text-warning">{a.errors}</div>
                      <div className="stat-label">errors</div>
                    </div>
                  )}
                  <div>
                    <div className="mono text-md font-bold">{fmtBytes(a.avgOutputSize)}</div>
                    <div className="stat-label">avg output</div>
                  </div>
                </div>
                {a.hasRateLimit && (
                  <div className="mono mt-2 text-2xs text-warning">
                    ⚠ Hit rate limit
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Multi-agent evaluation scores */}
          <div className="mt-4">
            <AgentScoreSummary handoffScore={handoffScore} avgRelevance={avgRelevance} completeness={completeness} />
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
          <div style={{ columns: `2 ${FILE_ACCESS_COL_MIN}`, columnGap: 'var(--space-8)' }}>
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
          badge={plural(gitCommits.length, 'commit')}
          health="ok"
        >
          <div className="flex-col gap-half">
            {gitCommits.map((commit) => {
              const commitFiles = commit.files?.split(' ') ?? [];
              return (
                <details key={commit.subject} className="border-b-subtle">
                  <summary className="flex-center gap-2-5 cursor-pointer list-none commit-summary">
                    <span className="text-healthy text-2xs shrink-0">●</span>
                    <span className="mono-xs font-semibold flex-1">
                      {commit.subject}
                    </span>
                    {commitFiles.length > 0 && (
                      <span className="text-2xs text-muted shrink-0">
                        {plural(commitFiles.length, 'file')}
                      </span>
                    )}
                  </summary>
                  <div className="commit-detail">
                    {commit.body && (
                      <div className="text-secondary text-xs leading-relaxed mb-2 commit-body">
                        {commit.body}
                      </div>
                    )}
                    {commitFiles.length > 0 && (
                      <div className="mono text-2xs text-muted">
                        {commitFiles.map((f) => (
                          <div key={f}>{shortPath(f)}</div>
                        ))}
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        </Section>
      )}

      {/* ── Code Quality ── */}
      {codeStructure.length > 0 && (
        <Section
          title="Code Quality"
          badge={`${plural(codeStructure.length, 'file')} analyzed`}
          health={codeStructure.some(f => f.score < CODE_QUALITY_WARN_THRESHOLD) ? 'warn' : 'ok'}
        >
          <div className="overflow-x-auto">
            <table className="mono-xs w-full table-collapse">
              <MonoTableHead columns={[
                { label: 'File', align: 'left' }, { label: 'Tool', align: 'left' },
                { label: 'Lines' }, { label: 'Exports' }, { label: 'Functions' },
                { label: 'Types' }, { label: 'Score' },
              ]} />
              <tbody>
                {codeStructure.map((f) => (
                  <tr key={`${f.file}:${f.tool}`} className="border-b-subtle">
                    <td className="cell-pad text-secondary">{shortPath(f.file)}</td>
                    <td className="cell-pad text-muted">{f.tool}</td>
                    <td className="cell-pad text-right">{f.lines}</td>
                    <td className="cell-pad text-right text-muted">{f.exports}</td>
                    <td className="cell-pad text-right text-muted">{f.functions}</td>
                    <td className="cell-pad text-center">{f.hasTypes ? '✓' : '·'}</td>
                    <td className="cell-pad text-right font-semibold" style={{ color: SCORE_COLORS[scoreColorBand(f.score)] }}>
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
        badge={`${spanCount} total · ${Object.keys(spanBreakdown).length} types`}
        health="neutral"
      >
        <FreqBarGrid entries={Object.entries(spanBreakdown)} max={maxSpanCount} color="var(--border-accent)" />
      </Section>

      {/* ── Evaluations ── */}
      <Section
        title="Evaluations"
        badge={evalRows.length > 0 ? plural(evalRows.length, 'result') : 'none'}
        health={hallucinationEvals.length > 0 ? 'crit' : failedEvals.length > 0 ? 'warn' : evalRows.length > 0 ? 'ok' : 'neutral'}
      >
        {evalRows.length === 0 ? (
          <div className="text-muted text-xs">
            No evaluations recorded for this session.
          </div>
        ) : (
          <EvaluationTable evaluations={evalRows} />
        )}
      </Section>
    </div>
  );
}
