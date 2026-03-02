import { BarIndicator } from './BarIndicator.js';

export function FreqBar({ label, count, max, color }: { label: string; count: number; max: number; color?: string }) {
  const pct = max > 0 ? (count / max) * 100 : 0;
  return (
    <div className="flex-center mb-1-5 gap-2-5">
      <div className="mono-xs text-secondary text-right shrink-0 truncate" style={{ width: 160 }}>{label}</div>
      <BarIndicator
        value={pct}
        height={6}
        color={color ?? 'var(--accent)'}
        trackColor="var(--bg-elevated)"
        style={{ flex: 1 }}
      />
      <div className="mono-xs text-muted text-right shrink-0" style={{ width: 36 }}>{count}</div>
    </div>
  );
}
