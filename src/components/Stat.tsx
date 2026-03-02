export function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="stat-item">
      <div className="stat-value mono font-bold" style={{ color: color ?? 'var(--text-primary)' }}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
