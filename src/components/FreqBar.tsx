import { BarIndicator } from './BarIndicator.js';

export function FreqBar({ label, count, max, color }: { label: string; count: number; max: number; color?: string }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="freq-bar-row">
      <div className="mono-xs text-secondary text-right truncate">{label}</div>
      <BarIndicator
        value={pct}
        height={6}
        color={color ?? 'var(--accent)'}
        trackColor="var(--bg-elevated)"
      />
      <div className="mono-xs text-muted text-right">{count}</div>
    </div>
  );
}
