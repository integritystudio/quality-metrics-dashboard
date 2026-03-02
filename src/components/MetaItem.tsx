export function MetaItem({ label, value }: { label: string; value?: string | number }) {
  if (value == null) return null;
  return (
    <div className="min-w-120">
      <div className="uppercase text-xs text-muted mb-1">{label}</div>
      <div className="mono-xs break-all mt-1">
        {value}
      </div>
    </div>
  );
}
