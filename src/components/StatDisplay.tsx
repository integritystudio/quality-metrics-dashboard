import type { ReactNode } from 'react';

interface StatDisplayProps {
  value: ReactNode;
  label: string;
  valueClassName?: string;
  valueColor?: string;
  variant?: 'inline' | 'card';
}

export function StatDisplay({ value, label, valueClassName, valueColor, variant = 'inline' }: StatDisplayProps) {
  const wrapperClass = variant === 'card'
    ? 'card summary-count p-4 min-w-120'
    : 'summary-count';

  return (
    <div className={wrapperClass}>
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
