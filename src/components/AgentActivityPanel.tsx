import { Fragment, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { greatest, max, sum } from 'd3-array';
import {
  createColumnHelper,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
  useTable,
  type SortingState,
} from '@tanstack/react-table';
import type { AgentStat, EvalMetricSummary } from '../hooks/useAgentStats.js';
import { scoreColor, scoreColorBand, formatCompactCount, formatPercent } from '../lib/quality-utils.js';
import { TruncatedIdLink } from './TruncatedIdLink.js';
import {
  AGENT_PALETTE, ERROR_RATE_WARNING_THRESHOLD,
  SPARKLINE_WIDTH, SPARKLINE_HEIGHT, SCORE_CHIP_PRECISION,
} from '../lib/constants.js';
import { routes } from '../lib/routes.js';
import { BarIndicator } from './BarIndicator.js';
import { EmptyState } from './EmptyState.js';
import { ExpandChevron } from './ExpandChevron.js';
import { SortableHeaderCell } from './SortableHeaderCell.js';
import { Sparkline } from './Sparkline.js';
import { StatDisplay, type StatTone } from './StatDisplay.js';

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
});

const AGENT_COLUMN_ID = 'agentName';
const DEFAULT_SORTING: SortingState = [{ id: 'invocations', desc: true }];

const columnHelper = createColumnHelper<typeof features, AgentStat>();

const columns = columnHelper.columns([
  columnHelper.accessor('agentName', { header: 'Agent', enableSorting: false }),
  columnHelper.accessor('invocations', { header: 'Invocations', sortFn: 'basic' }),
  columnHelper.accessor('errorRate', { header: 'Error Rate', sortFn: 'basic' }),
  columnHelper.accessor('sessionCount', { header: 'Sessions', sortFn: 'basic' }),
  columnHelper.accessor('avgOutputSize', { header: 'Avg Output', sortFn: 'basic' }),
  columnHelper.display({ id: 'rateLimits', header: 'Rate Limits' }),
  columnHelper.display({ id: 'source', header: 'Source' }),
]);

interface IdListColumnProps {
  label: string;
  ids: string[];
  totalCount: number;
  isTruncated: boolean;
  routeFn: (id: string) => string;
}

function IdListColumn({ label, ids, totalCount, isTruncated, routeFn }: IdListColumnProps) {
  return (
    <div>
      <div className="text-muted mb-1-5 text-xs uppercase">{label} ({totalCount})</div>
      <div className="flex-col gap-1">
        {ids.map(id => (
          <TruncatedIdLink
            key={id}
            id={id}
            href={routeFn(id)}
            maxLen={12}
            onClick={(e) => e.stopPropagation()}
          />
        ))}
        {ids.length === 0 && <span className="text-muted text-xs">none</span>}
        {isTruncated && (
          <span className="text-muted text-2xs italic">+{totalCount - ids.length} more</span>
        )}
      </div>
    </div>
  );
}

function errorRateTone(rate: number): StatTone {
  if (rate === 0) return 'healthy';
  if (rate < ERROR_RATE_WARNING_THRESHOLD) return 'warning';
  return 'critical';
}

interface AgentActivityPanelProps {
  agents: AgentStat[];
}

export function AgentActivityPanel({ agents }: AgentActivityPanelProps) {
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
  const [expanded, setExpanded] = useState<string | null>(null);

  const colorIndex = useMemo(
    () => {
      const m = new Map<string, string>();
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (!a) continue;
        m.set(a.agentName, AGENT_PALETTE[i % AGENT_PALETTE.length] ?? AGENT_PALETTE[0]);
      }
      return m;
    },
    [agents],
  );

  const table = useTable({
    features,
    data: agents,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    sortDescFirst: true,
    enableSortingRemoval: false,
    enableMultiSort: false,
  });

  if (agents.length === 0) {
    return <EmptyState message="No agent activity recorded for this period." />;
  }

  const maxInvocations = Math.max(max(agents, a => a.invocations) ?? 0, 1);

  return (
    <div className="overflow-x-auto">
      <table className="data-table sla-table agent-activity-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => (
                <SortableHeaderCell
                  key={header.id}
                  column={header.column}
                  className={header.column.id === AGENT_COLUMN_ID ? 'col-agent' : undefined}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </SortableHeaderCell>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(({ original: agent }) => {
            const color = colorIndex.get(agent.agentName) ?? AGENT_PALETTE[0];
            const errStatus = agent.errorRate === 0 ? 'ok' : agent.errorRate < ERROR_RATE_WARNING_THRESHOLD ? 'warn' : 'critical';
            const invPct = (agent.invocations / maxInvocations) * 100;
            const topSource = greatest(Object.entries(agent.sourceTypes), ([, count]) => count)?.[0];
            const isExpanded = expanded === agent.agentName;
            const hasLinks = agent.sessionIds.length > 0 || agent.traceIds.length > 0;

            return (
              <Fragment key={agent.agentName}>
                <tr
                  className={`valign-middle${isExpanded ? ' eval-row-expanded' : ''}${hasLinks ? ' cursor-pointer' : ''}`}
                  style={{ '--agent-color': color } as CSSProperties}
                  onClick={() => hasLinks && setExpanded(isExpanded ? null : agent.agentName)}
                >
                  <td>
                    <div className="flex-center gap-2">
                      {hasLinks && (
                        <ExpandChevron expanded={isExpanded} className="text-2xs text-muted shrink-0" />
                      )}
                      <span className="dot-sm agent-dot" />
                      <span className="mono-xs text-primary break-all">
                        {agent.agentName}
                      </span>
                    </div>
                  </td>

                  <td>
                    <div className="flex-center gap-2">
                      <span className="mono-xs agent-inv-count">
                        {agent.invocations}
                      </span>
                      <BarIndicator value={invPct} color={color} opacity={0.7} className="flex-1 agent-inv-bar" />
                    </div>
                  </td>

                  <td>
                    <div className="flex-center gap-1-5">
                      <span className="mono-xs agent-err-rate" data-err-status={errStatus}>
                        {agent.errors > 0 ? formatPercent(agent.errorRate * 100) : '\u2014'}
                      </span>
                      {agent.errors > 0 && (
                        <span className="text-muted text-xs">
                          ({agent.errors})
                        </span>
                      )}
                    </div>
                  </td>

                  <td>
                    <span className="mono-xs">
                      {agent.sessionCount}
                    </span>
                  </td>

                  <td>
                    <span className="mono-xs text-secondary">
                      {formatCompactCount(agent.avgOutputSize)}
                    </span>
                  </td>

                  <td>
                    {agent.rateLimitCount > 0 ? (
                      <span className="mono-xs badge-warning">
                        {agent.rateLimitCount}x
                      </span>
                    ) : (
                      <span className="text-muted text-xs">{'\u2014'}</span>
                    )}
                  </td>

                  <td>
                    {topSource ? (
                      <span className="mono text-muted text-2xs uppercase">
                        {topSource}
                      </span>
                    ) : <span className="text-muted">{'\u2014'}</span>}
                  </td>
                </tr>

                {isExpanded && (
                  <tr className="eval-expanded-panel">
                    <td colSpan={columns.length} className="border-b">
                      <EvalSummaryRow evalSummary={agent.evalSummary} />

                      {agent.dailyCounts.length > 1 && agent.dailyCounts.some(v => v > 0) && (
                        <div className="border-b-subtle mb-1 pad-panel-section">
                          <div className="flex-center-gap-3">
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
                              peak {max(agent.dailyCounts) ?? 0}/day
                            </span>
                          </div>
                        </div>
                      )}

                      <div className="agent-expanded-grid">
                        <IdListColumn
                          label="Sessions"
                          ids={agent.sessionIds}
                          totalCount={agent.sessionCount}
                          isTruncated={agent.sessionIdsTruncated}
                          routeFn={routes.session}
                        />
                        <IdListColumn
                          label="Traces"
                          ids={agent.traceIds}
                          totalCount={agent.traceIdsTotal}
                          isTruncated={agent.traceIdsTruncated}
                          routeFn={routes.trace}
                        />
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
          const band = scoreColorBand(m.avg);
          return (
            <div key={name} className="metric-card-compact">
              <div className="text-secondary mb-1 text-xs truncate">
                {name}
              </div>
              <div className="flex-center mb-1 gap-2">
                <BarIndicator value={Math.min(m.avg * 100, 100)} color={barColor} className="flex-1" />
                <span className="mono-xs font-semibold text-right score-label-width score-band" data-band={band}>
                  {m.avg.toFixed(SCORE_CHIP_PRECISION)}
                </span>
              </div>
              <div className="mono text-muted flex-wrap justify-between text-2xs">
                <span>{m.min.toFixed(SCORE_CHIP_PRECISION)}\u2013{m.max.toFixed(SCORE_CHIP_PRECISION)}</span>
                <span>n={m.count}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function AgentActivitySummary({ agents }: AgentActivityPanelProps) {
  const totalInvocations = sum(agents, a => a.invocations);
  const totalErrors = sum(agents, a => a.errors);
  const totalRateLimits = sum(agents, a => a.rateLimitCount);
  const rawErrorRate = totalInvocations > 0 ? totalErrors / totalInvocations : 0;
  const overallErrorRate = rawErrorRate * 100;

  const stats: Array<{ label: string; value: ReactNode; tone?: StatTone | undefined }> = [
    { label: 'Agents', value: agents.length },
    { label: 'Invocations', value: totalInvocations.toLocaleString() },
    {
      label: 'Error Rate',
      value: totalInvocations > 0 ? formatPercent(overallErrorRate) : '\u2014',
      tone: errorRateTone(rawErrorRate),
    },
    {
      label: 'Rate Limits',
      value: totalRateLimits > 0 ? totalRateLimits : '\u2014',
      tone: totalRateLimits > 0 ? 'warning' : undefined,
    },
  ];

  return (
    <div className="d-flex flex-wrap gap-8 surface-elevated mb-5 p-4-5">
      {stats.map(({ label, value, tone }) => (
        <StatDisplay key={label} value={value} label={label} tone={tone} />
      ))}
    </div>
  );
}
