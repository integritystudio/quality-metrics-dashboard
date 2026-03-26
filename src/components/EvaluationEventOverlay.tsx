import { Link } from 'wouter';
import { ScoreBadge } from './ScoreBadge.js';
import { routes } from '../lib/routes.js';
import { SCORE_CHIP_PRECISION } from '../lib/constants.js';
import type { EvaluationResult } from '../types.js';

interface EvaluationEventOverlayProps {
  evaluations: EvaluationResult[];
  traceId?: string;
}

export function EvaluationEventOverlay({ evaluations, traceId }: EvaluationEventOverlayProps) {
  if (evaluations.length === 0) return null;

  const byName = new Map<string, EvaluationResult[]>();
  for (const ev of evaluations) {
    const name = ev.evaluationName;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(ev);
  }

  return (
    <div className="flex-wrap gap-2">
      {[...byName.entries()].map(([name, evs]) => {
        const avg = evs.reduce((s, e) => s + (e.scoreValue ?? 0), 0) / evs.length;
        const card = (
          <div className={`flex-center gap-1-5 surface-elevated eval-overlay-card${traceId ? ' eval-summary-card' : ''}`}>
            <span className="text-xs">{name}</span>
            <ScoreBadge score={avg} metricName={name} label={avg.toFixed(SCORE_CHIP_PRECISION)} />
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
