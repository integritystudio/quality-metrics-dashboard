import { scoreColor, formatPercent } from '../lib/quality-utils.js';
import type { CompositeQualityIndex, CQIContribution } from '../types.js';
import { SCORE_CHIP_PRECISION, SCORE_DISPLAY_PRECISION } from '../lib/constants.js';

function segmentColor(contribution: CQIContribution): string {
  return scoreColor(contribution.rawScore, 'maximize');
}

export function CQIHero({ cqi }: { cqi: CompositeQualityIndex }) {
  const displayValue = (cqi.value * 100).toFixed(1);
  const overallColor = scoreColor(cqi.value, 'maximize');

  return (
    <div
      role="region"
      aria-label={`Composite Quality Index: ${displayValue}`}
      className="card text-center p-6"
    >
      <div className="field-label text-secondary text-xs mb-1">
        Composite Quality Index
      </div>
      <div
        className="mono font-bold cqi-value"
        style={{ color: overallColor }}
      >
        {displayValue}
      </div>

      {cqi.contributions.length > 0 && (
        <div className="d-flex mt-4 cqi-segment-bar">
          {cqi.contributions.map((c) => (
            <div
              key={c.metric}
              title={`${c.metric}: ${c.rawScore.toFixed(SCORE_CHIP_PRECISION)} (weight ${formatPercent(c.weight * 100, 0)})`}
              style={{
                flex: c.weight,
                backgroundColor: segmentColor(c),
                minWidth: 'var(--space-0-5)',
              }}
            />
          ))}
        </div>
      )}

      {/* Screen reader breakdown table */}
      <table className="sr-only">
        <caption>CQI Metric Breakdown</caption>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Raw Score</th>
            <th>Weight</th>
            <th>Contribution</th>
          </tr>
        </thead>
        <tbody>
          {cqi.contributions.map((c) => (
            <tr key={c.metric}>
              <td>{c.metric}</td>
              <td>{c.rawScore.toFixed(SCORE_CHIP_PRECISION)}</td>
              <td>{formatPercent(c.weight * 100, 0)}</td>
              <td>{c.contribution.toFixed(SCORE_DISPLAY_PRECISION)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
