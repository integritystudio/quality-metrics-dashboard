import type { ReactNode } from 'react';

interface StatDisplayProps {
  value: ReactNode;
  label: string;
  valueClassName?: string | undefined;
  variant?: 'inline' | 'card' | undefined;
}

export function StatDisplay({ value, label, valueClassName, variant = 'inline' }: StatDisplayProps) {
  const wrapperClass = variant === 'card'
    ? 'card summary-count p-4 min-w-120'
    : 'summary-count';

  return (
    <div className={wrapperClass}>
      <div className={`value${valueClassName ? ` ${valueClassName}` : ''}`}>
        {value}
      </div>
      <div className="label text-secondary text-xs">{label}</div>
    </div>
  );
}
