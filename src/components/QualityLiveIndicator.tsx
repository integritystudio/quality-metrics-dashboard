import { useQualityLive } from '../hooks/useQualityLive.js';
import { calibratedScoreColorBand, formatTimestamp, scoreDirectionForMetric } from '../lib/quality-utils.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';
import { useMetricCalibration } from '../contexts/CalibrationContext.js';
import type { QualityLiveData } from '../types.js';

type LiveMetric = QualityLiveData['metrics'][number];

function QualityLiveChip({ metric }: { metric: LiveMetric }) {
  const calibration = useMetricCalibration(metric.name);
  const band = calibratedScoreColorBand(metric.score, metric.name, scoreDirectionForMetric(metric.name), calibration);
  return (
    <span
      title={`${metric.name}: ${metric.score.toFixed(SCORE_CHIP_PRECISION)} (${metric.evaluatorType})`}
      className="mono text-xs chip gap-1 font-medium inline-flex-center quality-chip"
      data-band={band}
    >
      <span className="dot-xs" />
      {metric.name.replace(/_/g, ' ')}
      <span className="font-bold">{metric.score.toFixed(SCORE_CHIP_PRECISION)}</span>
    </span>
  );
}

export function QualityLiveIndicator() {
  const { data, isLoading, error } = useQualityLive();

  if (isLoading) {
    return <div className="quality-live-bar opacity-50">Loading quality signals...</div>;
  }

  if (error || !data) {
    return null;
  }

  if (data.metrics.length === 0) {
    return null;
  }

  return (
    <div
      className="quality-live-bar flex-center gap-2 text-xs surface-elevated"
      role="status"
      aria-label="Live quality signals"
    >
      <span className="text-secondary font-semibold mr-1">
        Quality
      </span>
      {data.metrics.map((m) => <QualityLiveChip key={m.name} metric={m} />)}
      <span className="text-secondary text-2xs ml-auto">
        {formatTimestamp(data.lastUpdated)}
      </span>
    </div>
  );
}
