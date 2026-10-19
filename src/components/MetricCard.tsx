import { memo, type ReactNode } from 'react';
import { Link } from 'wouter';
import type { QualityMetricResult, WorstExplanation } from '../types.js';
import { StatusBadge, TrendIndicator, ConfidenceBadge } from './Indicators.js';
import { ScoreBadge } from './ScoreBadge.js';
import { Sparkline } from './Sparkline.js';
import { inferScoreDirection, truncateText, plural, formatScore } from '../lib/quality-utils.js';
import { EXPLANATION_INLINE_CHARS, SCORE_CHIP_PRECISION } from '../lib/constants.js';

type MetricStatus = QualityMetricResult['status'];

/** Card glow, for the two statuses that get one. */
const GLOW_CLASS: Partial<Record<MetricStatus, string>> = {
  critical: 'glow-critical',
  warning: 'glow-warning',
};

/** Sparkline stroke, which follows the glow but falls back to the accent. */
const SPARKLINE_COLOR: Partial<Record<MetricStatus, string>> = {
  critical: 'var(--status-critical)',
  warning: 'var(--status-warning)',
};

const SPARKLINE_MIN_POINTS = 2;
const SPARKLINE_WIDTH = 120;
const SPARKLINE_HEIGHT = 24;

/** A single point cannot show a trend, so the strip is dropped below two. */
function MetricSparkline({ data, status, displayName }: {
  data: Array<number | null> | undefined;
  status: MetricStatus;
  displayName: string;
}): ReactNode {
  if (!data || data.length < SPARKLINE_MIN_POINTS) return null;
  return (
    <div className="mt-2">
      <Sparkline
        data={data}
        width={SPARKLINE_WIDTH}
        height={SPARKLINE_HEIGHT}
        color={SPARKLINE_COLOR[status] ?? 'var(--accent)'}
        label={`${displayName} score trend`}
      />
    </div>
  );
}

function MetricCardInner({ metric, sparklineData }: {
  metric: QualityMetricResult;
  sparklineData: Array<number | null> | undefined;
}) {
  const { name, displayName, sampleCount, status, values, trend, confidence, alerts } = metric;
  const worst = (metric as QualityMetricResult & { worstExplanation?: WorstExplanation }).worstExplanation;
  const primaryValue = values.avg;
  const glowClass = GLOW_CLASS[status] ?? '';

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
              direction={inferScoreDirection(alerts[0]?.direction)}
              label={formatScore(primaryValue)}
            />
            {trend && <TrendIndicator trend={trend} />}
          </div>
          <div className="secondary">
            p50: {formatScore(values.p50)} &middot; p95: {formatScore(values.p95)}
          </div>
        </div>

        <MetricSparkline data={sparklineData} status={status} displayName={displayName} />

        <div className="metric-footer flex-center">
          <span>n={sampleCount} <ConfidenceBadge confidence={confidence} /></span>
          {alerts.length > 0 && (
            <span className="text-warning">
              {'\u25B2'} {plural(alerts.length, 'alert')}
            </span>
          )}
        </div>

        {worst?.explanation && (
          <div className="metric-worst truncate" title={worst.explanation}>
            <span className="worst-score">{worst.score.toFixed(SCORE_CHIP_PRECISION)}</span>{' '}
            {truncateText(worst.explanation, EXPLANATION_INLINE_CHARS)}
          </div>
        )}
      </div>
    </Link>
  );
}

export const MetricCard = memo(MetricCardInner);
