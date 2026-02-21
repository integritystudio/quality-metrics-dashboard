import { ScoreBadge } from './ScoreBadge.js';
import type { EvaluationResult } from '../types.js';

interface EvaluationEventOverlayProps {
  evaluations: EvaluationResult[];
}

export function EvaluationEventOverlay({ evaluations }: EvaluationEventOverlayProps) {
  if (evaluations.length === 0) return null;

  const byName = new Map<string, EvaluationResult[]>();
  for (const ev of evaluations) {
    const name = ev.evaluationName;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name)!.push(ev);
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {[...byName.entries()].map(([name, evs]) => {
        const avg = evs.reduce((s, e) => s + (e.scoreValue ?? 0), 0) / evs.length;
        return (
          <div key={name} style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px', borderRadius: 6,
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 12 }}>{name}</span>
            <ScoreBadge score={avg} metricName={name} label={avg.toFixed(2)} />
            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>({evs.length})</span>
          </div>
        );
      })}
    </div>
  );
}
