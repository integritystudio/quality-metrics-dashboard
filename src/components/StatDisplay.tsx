import type { ReactNode } from 'react';

export type StatTone = 'healthy' | 'warning' | 'critical' | 'secondary';

const STAT_TONE_CLASS: Record<StatTone, string> = {
  healthy: 'text-healthy',
  warning: 'text-warning',
  critical: 'text-critical',
  secondary: 'text-secondary',
};

type StatDisplayProps = {
  value: ReactNode;
  label: string;
  tone?: StatTone | undefined;
  variant?: 'inline' | 'card' | undefined;
}

export function StatDisplay({ value, label, tone, variant = 'inline' }: StatDisplayProps) {
  const wrapperClass = variant === 'card'
    ? 'card summary-count p-4 min-w-120'
    : 'summary-count';

  return (
    <div className={wrapperClass}>
      <div className={`value${tone ? ` ${STAT_TONE_CLASS[tone]}` : ''}`}>
        {value}
      </div>
      <div className="label text-secondary text-xs">{label}</div>
    </div>
  );
}
