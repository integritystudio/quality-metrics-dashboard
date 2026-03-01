import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import type { CompositeQualityIndex, CQIContribution } from '../types.js';

function segmentColor(contribution: CQIContribution): string {
  const band = scoreColorBand(contribution.rawScore, 'maximize');
  return SCORE_COLORS[band];
}

export function CQIHero({ cqi }: { cqi: CompositeQualityIndex }) {
  const displayValue = (cqi.value * 100).toFixed(1);
  const overallBand = scoreColorBand(cqi.value, 'maximize');

  return (
    <div
      role="region"
      aria-label={`Composite Quality Index: ${displayValue}`}
      className="card text-center"
      style={{ padding: 24 }}
    >
      <div className="field-label text-secondary text-xs mb-1">
        Composite Quality Index
      </div>
      <div
        className="mono"
        style={{
          fontSize: 36,
          fontWeight: 700,
          color: SCORE_COLORS[overallBand],
          lineHeight: 1.2,
        }}
      >
        {displayValue}
      </div>

      {cqi.contributions.length > 0 && (
        <div
          style={{
            display: 'flex',
            height: 8,
            borderRadius: 4,
            overflow: 'hidden',
            marginTop: 16,
          }}
        >
          {cqi.contributions.map((c) => (
            <div
              key={c.metric}
              title={`${c.metric}: ${c.rawScore.toFixed(2)} (weight ${(c.weight * 100).toFixed(0)}%)`}
              style={{
                flex: c.weight,
                backgroundColor: segmentColor(c),
                minWidth: 2,
              }}
            />
          ))}
        </div>
      )}

      {/* Screen reader breakdown table */}
      <table style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0,0,0,0)' }}>
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
              <td>{c.rawScore.toFixed(2)}</td>
              <td>{(c.weight * 100).toFixed(0)}%</td>
              <td>{c.contribution.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
