import type { ReactNode } from 'react';

interface SummaryCountProps {
  value: ReactNode;
  label: string;
  valueClassName?: string;
  valueColor?: string;
}

export function SummaryCount({ value, label, valueClassName, valueColor }: SummaryCountProps) {
  return (
    <div className="summary-count">
      <div
        className={`value${valueClassName ? ` ${valueClassName}` : ''}`}
        style={valueColor ? { color: valueColor } : undefined}
      >
        {value}
      </div>
      <div className="label text-secondary text-xs">{label}</div>
    </div>
  );
}
