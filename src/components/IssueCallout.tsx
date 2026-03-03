import type { ReactNode } from 'react';

interface IssueCalloutProps {
  severity: 'warning' | 'critical';
  title: string;
  children: ReactNode;
}

export function IssueCallout({ severity, title, children }: IssueCalloutProps) {
  const color = severity === 'critical' ? 'var(--status-critical)' : 'var(--status-warning)';
  return (
    <div className="mb-2-5" style={{
      borderLeft: `var(--border-width-rail) solid ${color}`,
      background: severity === 'critical' ? 'var(--bg-status-critical)' : 'var(--bg-status-warning)',
      borderRadius: '0 var(--radius) var(--radius) 0',
      padding: 'var(--space-2-5) var(--space-3-5)',
    }}>
      <div className="mono-xs uppercase font-semibold mb-1" style={{
        color,
      }}>{title}</div>
      <div className="text-secondary text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}
