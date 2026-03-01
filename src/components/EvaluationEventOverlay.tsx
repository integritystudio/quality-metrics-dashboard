import { Link } from 'wouter';
import { ScoreBadge } from './ScoreBadge.js';
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
          <div style={{
            padding: '4px 8px', borderRadius: 6,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
            ...(traceId ? { cursor: 'pointer', transition: 'border-color 0.15s' } : {}),
          }}
          className={traceId ? 'flex-center eval-summary-card gap-1-5' : 'flex-center gap-1-5'}
          >
            <span className="text-xs">{name}</span>
            <ScoreBadge score={avg} metricName={name} label={avg.toFixed(2)} />
            <span className="text-muted text-2xs">({evs.length})</span>
          </div>
        );

        if (traceId) {
          return (
            <Link
              key={name}
              href={`/evaluations/trace/${traceId}?metric=${encodeURIComponent(name)}`}
              style={{ textDecoration: 'none', color: 'inherit' }}
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
