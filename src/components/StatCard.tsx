import type { ReactNode } from 'react';

interface StatCardProps {
  value: ReactNode;
  label: string;
  valueColor?: string;
}

export function StatCard({ value, label, valueColor }: StatCardProps) {
  return (
    <div className="card summary-count p-4 min-w-120">
      <div className="value" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </div>
      <div className="label text-secondary text-xs">{label}</div>
    </div>
  );
}
