import { Link } from 'wouter';
import { group, mean } from 'd3-array';
import { ScoreBadge } from './ScoreBadge.js';
import { routes } from '../lib/routes.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';
import { formatScore } from '../lib/quality-utils.js';
import type { EvaluationResult } from '../types.js';

interface EvaluationEventOverlayProps {
  evaluations: EvaluationResult[];
  traceId?: string;
}

export function EvaluationEventOverlay({ evaluations, traceId }: EvaluationEventOverlayProps) {
  if (evaluations.length === 0) return null;

  const byName = group(evaluations, ev => ev.evaluationName);

  return (
    <div className="flex-wrap gap-2">
      {[...byName.entries()].map(([name, evs]) => {
        // Unscored evaluations are left out of the mean rather than counted as 0.
        const avg = mean(evs, e => e.scoreValue) ?? null;
        const card = (
          <div className={`flex-center gap-1-5 surface-elevated eval-overlay-card${traceId ? ' eval-summary-card' : ''}`}>
            <span className="text-xs">{name}</span>
            <ScoreBadge score={avg} metricName={name} label={avg === null ? formatScore(avg) : avg.toFixed(SCORE_CHIP_PRECISION)} />
            <span className="text-muted text-2xs">({evs.length})</span>
          </div>
        );

        if (traceId) {
          return (
            <Link
              key={name}
              href={routes.evaluationDetail(traceId, name)}
              className="link-plain"
            >
              {card}
            </Link>
          );
        }

        return <div key={name}>{card}</div>;
      })}
    </div>
  );
}
