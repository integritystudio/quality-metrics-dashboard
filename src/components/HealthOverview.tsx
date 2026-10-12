import type { QualityDashboardSummary } from '../types.js';
import { formatCompactCount, formatTimestamp } from '../lib/quality-utils.js';
import { TIME_MS, PERIOD_MS } from '../lib/constants.js';
import { HealthBanner } from './HealthBanner.js';
import { StatDisplay } from './StatDisplay.js';

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
    const worst = (m as QualityDashboardSummary['metrics'][number] & { worstExplanation?: { timestamp?: string } }).worstExplanation;
    if (worst?.timestamp && (!latestTs || worst.timestamp > latestTs)) latestTs = worst.timestamp;
  }

  const lastEvalAge = latestTs ? formatTimestamp(latestTs) : null;

  const period = dashboard.metrics[0]?.period;
  let periodHours = PERIOD_MS['7d'] / TIME_MS.HOUR;
  if (period) {
    const diffMs = new Date(period.end).getTime() - new Date(period.start).getTime();
    periodHours = Math.max(1, diffMs / TIME_MS.HOUR);
  }
  const perHour = totalSamples / periodHours;
  const evalRate = perHour >= 1 ? `${formatCompactCount(Math.round(perHour))}/hr`
    : `${formatCompactCount(perHour * (TIME_MS.DAY / TIME_MS.HOUR))}/day`;

  return { evalVolume: totalSamples, lastEvalAge, evalRate };
}

export function HealthOverview({ dashboard }: { dashboard: QualityDashboardSummary }) {
  const { overallStatus, summary } = dashboard;
  const pipeline = computePipelineHealth(dashboard);

  const statusMessage = <>
    <span className="text-base">
      {overallStatus === 'healthy' && 'All metrics within thresholds'}
      {overallStatus === 'warning' && 'Some metrics need attention'}
      {overallStatus === 'critical' && 'Critical issues detected'}
      {overallStatus === 'no_data' && 'No evaluation data available'}
    </span>
    <div className="pipeline-stats d-flex gap-6">
      <div className="pipeline-stat flex-center">
        Eval Volume: <span className="stat-value">{formatCompactCount(pipeline.evalVolume)}</span>
      </div>
      <div className="pipeline-stat flex-center">
        Rate: <span className="stat-value">{pipeline.evalRate}</span>
      </div>
      {pipeline.lastEvalAge && (
        <div className="pipeline-stat flex-center">
          Last Eval: <span className="stat-value">{pipeline.lastEvalAge}</span>
        </div>
      )}
    </div>
  </>;

  return (
    <HealthBanner status={overallStatus} message={statusMessage}>
      <StatDisplay value={summary.totalMetrics} label="Total" />
      <StatDisplay value={summary.healthyMetrics} label="Healthy" tone="healthy" />
      <StatDisplay value={summary.warningMetrics} label="Warning" tone="warning" />
      <StatDisplay value={summary.criticalMetrics} label="Critical" tone="critical" />
    </HealthBanner>
  );
}
