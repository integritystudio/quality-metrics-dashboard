export function MetaItem({ label, value }: { label: string; value?: string | number }) {
  if (value == null) return null;
  return (
    <div style={{ minWidth: 120 }}>
      <div className="section-label">{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, marginTop: 2, wordBreak: 'break-all' }}>
        {value}
      </div>
    </div>
  );
}
