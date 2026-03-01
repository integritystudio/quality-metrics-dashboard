import { memo } from 'react';
import { Link } from 'wouter';
import type { QualityMetricResult, WorstExplanation } from '../types.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './Indicators.js';
import { ScoreBadge } from './ScoreBadge.js';
import { Sparkline } from './Sparkline.js';
import { inferScoreDirection, truncateText, plural } from '../lib/quality-utils.js';

function formatValue(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'N/A';
  return val.toFixed(4);
}

function MetricCardInner({ metric, sparklineData }: {
  metric: QualityMetricResult;
  sparklineData?: (number | null)[];
}) {
  const { name, displayName, sampleCount, status, values, trend, confidence, alerts } = metric;
  const worst = (metric as QualityMetricResult & { worstExplanation?: WorstExplanation }).worstExplanation;
  const primaryValue = values.avg;
  const glowClass = status === 'critical' ? 'glow-critical' : status === 'warning' ? 'glow-warning' : '';

  return (
    <Link href={`/metrics/${name}`} className="card-link" aria-label={`View ${displayName} metric details`}>
      <div className={`card ${glowClass}`}>
        <div className="metric-card-header">
          <h3>{displayName}</h3>
          <StatusBadge status={status} />
        </div>
        <div className="metric-values">
          <div className="primary">
            <ScoreBadge
              score={primaryValue ?? null}
              metricName={name}
              direction={inferScoreDirection(alerts?.[0]?.direction)}
              label={formatValue(primaryValue)}
            />
            {trend && <> <TrendIndicator trend={trend} /></>}
          </div>
          <div className="secondary">
            p50: {formatValue(values.p50)} &middot; p95: {formatValue(values.p95)}
          </div>
        </div>

        {sparklineData && sparklineData.length >= 2 && (
          <div style={{ marginTop: 8 }}>
            <Sparkline
              data={sparklineData}
              width={120}
              height={24}
              color={status === 'critical' ? 'var(--status-critical)' : status === 'warning' ? 'var(--status-warning)' : 'var(--accent)'}
              label={`${displayName} score trend`}
            />
          </div>
        )}

        <div className="metric-footer">
          <span>n={sampleCount} <ConfidenceBadge confidence={confidence} /></span>
          {alerts.length > 0 && (
            <span style={{ color: 'var(--status-warning)' }}>
              {'\u25B2'} {plural(alerts.length, 'alert')}
            </span>
          )}
        </div>

        {worst && worst.explanation && (
          <div className="metric-worst" title={worst.explanation}>
            <span className="worst-score">{worst.score.toFixed(2)}</span>{' '}
            {truncateText(worst.explanation, 60)}
          </div>
        )}
      </div>
    </Link>
  );
}

export const MetricCard = memo(MetricCardInner);
