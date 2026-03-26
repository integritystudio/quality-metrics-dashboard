import { memo } from 'react';
import { Link } from 'wouter';
import type { QualityMetricResult, WorstExplanation } from '../types.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './Indicators.js';
import { ScoreBadge } from './ScoreBadge.js';
import { Sparkline } from './Sparkline.js';
import { inferScoreDirection, truncateText, plural, formatScore } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';

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
        <div className="metric-card-header flex-center">
          <h3>{displayName}</h3>
          <StatusBadge status={status} />
        </div>
        <div className="metric-values">
          <div className="primary">
            <ScoreBadge
              score={primaryValue ?? null}
              metricName={name}
              direction={inferScoreDirection(alerts?.[0]?.direction)}
              label={formatScore(primaryValue)}
            />
            {trend && <> <TrendIndicator trend={trend} /></>}
          </div>
          <div className="secondary">
            p50: {formatScore(values.p50)} &middot; p95: {formatScore(values.p95)}
          </div>
        </div>

        {sparklineData && sparklineData.length >= 2 && (
          <div className="mt-2">
            <Sparkline
              data={sparklineData}
              width={120}
              height={24}
              color={status === 'critical' ? 'var(--status-critical)' : status === 'warning' ? 'var(--status-warning)' : 'var(--accent)'}
              label={`${displayName} score trend`}
            />
          </div>
        )}

        <div className="metric-footer flex-center">
          <span>n={sampleCount} <ConfidenceBadge confidence={confidence} /></span>
          {alerts.length > 0 && (
            <span className="text-warning">
              {'\u25B2'} {plural(alerts.length, 'alert')}
            </span>
          )}
        </div>

        {worst && worst.explanation && (
          <div className="metric-worst truncate" title={worst.explanation}>
            <span className="worst-score">{worst.score.toFixed(SCORE_CHIP_PRECISION)}</span>{' '}
            {truncateText(worst.explanation, 60)}
          </div>
        )}
      </div>
    </Link>
  );
}

export const MetricCard = memo(MetricCardInner);
