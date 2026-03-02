import type { ReactNode } from 'react';

/** Horizontal label–value row. Renders nothing when value is nullish. */
export function MetadataRow({ label, value, mono }: {
  label: string;
  value?: ReactNode;
  mono?: boolean;
}) {
  if (value == null) return null;
  return (
    <div className="tooltip-row">
      <span className="text-secondary">{label}</span>
      <span className={mono ? 'mono-xs' : undefined}>{value}</span>
    </div>
  );
}
