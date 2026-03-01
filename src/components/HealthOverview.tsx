import type { QualityDashboardSummary } from '../types.js';
import { StatusBadge } from './Indicators.js';
import { formatTimestamp } from '../lib/quality-utils.js';

interface PipelineHealth {
  evalVolume: number;
  lastEvalAge: string | null;
  evalRate: string;
}

function computePipelineHealth(dashboard: QualityDashboardSummary): PipelineHealth {
  let totalSamples = 0;
  let latestTs: string | null = null;

  for (const m of dashboard.metrics) {
    totalSamples += m.sampleCount;
  }

  // Find most recent evaluation timestamp from worst explanations
  for (const m of dashboard.metrics) {
    const worst = (m as QualityDashboardSummary['metrics'][number] & { worstExplanation?: { timestamp?: string } }).worstExplanation;
    if (worst?.timestamp) {
      if (!latestTs || worst.timestamp > latestTs) latestTs = worst.timestamp;
    }
  }

  const lastEvalAge = latestTs ? formatTimestamp(latestTs) : null;

  // Compute rate based on period
  const period = dashboard.metrics[0]?.period;
  let periodHours = 168; // default 7d
  if (period) {
    const diffMs = new Date(period.end).getTime() - new Date(period.start).getTime();
    periodHours = Math.max(1, diffMs / (60 * 60 * 1000));
  }
  const perHour = totalSamples / periodHours;
  const evalRate = perHour >= 100 ? `${(perHour / 1000).toFixed(1)}k/hr`
    : perHour >= 1 ? `${perHour.toFixed(0)}/hr`
    : `${(perHour * 24).toFixed(1)}/day`;

  return { evalVolume: totalSamples, lastEvalAge, evalRate };
}

function formatVolume(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function HealthOverview({ dashboard }: { dashboard: QualityDashboardSummary }) {
  const { overallStatus, summary } = dashboard;
  const pipeline = computePipelineHealth(dashboard);

  return (
    <div className={`health-banner ${overallStatus}`}>
      <div>
        <div className="flex-center gap-3">
          <StatusBadge status={overallStatus} />
          <span className="text-base">
            {overallStatus === 'healthy' && 'All metrics within thresholds'}
            {overallStatus === 'warning' && 'Some metrics need attention'}
            {overallStatus === 'critical' && 'Critical issues detected'}
            {overallStatus === 'no_data' && 'No evaluation data available'}
          </span>
        </div>
        <div className="pipeline-stats">
          <div className="pipeline-stat">
            Eval Volume: <span className="stat-value">{formatVolume(pipeline.evalVolume)}</span>
          </div>
          <div className="pipeline-stat">
            Rate: <span className="stat-value">{pipeline.evalRate}</span>
          </div>
          {pipeline.lastEvalAge && (
            <div className="pipeline-stat">
              Last Eval: <span className="stat-value">{pipeline.lastEvalAge}</span>
            </div>
          )}
        </div>
      </div>
      <div className="summary-counts">
        <div className="summary-count">
          <div className="value">{summary.totalMetrics}</div>
          <div className="label text-secondary text-xs">Total</div>
        </div>
        <div className="summary-count">
          <div className="value text-healthy">{summary.healthyMetrics}</div>
          <div className="label text-secondary text-xs">Healthy</div>
        </div>
        <div className="summary-count">
          <div className="value text-warning">{summary.warningMetrics}</div>
          <div className="label text-secondary text-xs">Warning</div>
        </div>
        <div className="summary-count">
          <div className="value text-critical">{summary.criticalMetrics}</div>
          <div className="label text-secondary text-xs">Critical</div>
        </div>
      </div>
    </div>
  );
}
