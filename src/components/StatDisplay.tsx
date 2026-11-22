import type { ReactNode } from 'react';

export type StatTone = 'healthy' | 'warning' | 'critical' | 'secondary';

const STAT_TONE_CLASS: Record<StatTone, string> = {
  healthy: 'text-healthy',
  warning: 'text-warning',
  critical: 'text-critical',
  secondary: 'text-secondary',
};

type StatVariant = 'inline' | 'card' | 'tile';

const STAT_VARIANT_CLASS: Record<StatVariant, { wrapper: string; value: string; label: string }> = {
  inline: { wrapper: 'summary-count', value: 'value', label: 'label text-secondary text-xs' },
  card: { wrapper: 'card summary-count p-4 min-w-120', value: 'value', label: 'label text-secondary text-xs' },
  tile: { wrapper: 'text-center', value: 'mono-xl font-semibold', label: 'text-secondary text-xs uppercase' },
};

type StatDisplayProps = {
  value: ReactNode;
  label: string;
  tone?: StatTone | undefined;
  variant?: StatVariant | undefined;
}

export function StatDisplay({ value, label, tone, variant = 'inline' }: StatDisplayProps) {
  const classes = STAT_VARIANT_CLASS[variant];
  return (
    <div className={classes.wrapper}>
      <div className={`${classes.value}${tone ? ` ${STAT_TONE_CLASS[tone]}` : ''}`}>
        {value}
      </div>
      <div className={classes.label}>{label}</div>
    </div>
  );
}
