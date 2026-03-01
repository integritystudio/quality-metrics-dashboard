export function MetaItem({ label, value }: { label: string; value?: string | number }) {
  if (value == null) return null;
  return (
    <div style={{ minWidth: 120 }}>
      <div className="section-label mb-1">{label}</div>
      <div className="mono-xs" style={{ marginTop: 2, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}
