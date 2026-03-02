export function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="text-center" style={{ flex: '1 1 100px', minWidth: 80 }}>
      <div className="mono font-bold" style={{
        fontSize: 22,
        color: color ?? 'var(--text-primary)',
        lineHeight: 1.1,
      }}>{value}</div>
      <div className="stat-label" style={{ letterSpacing: '0.1em', marginTop: 3 }}>{label}</div>
    </div>
  );
}
