import type { ReactNode } from 'react';

interface IssueCalloutProps {
  severity: 'warning' | 'critical';
  title: string;
  children: ReactNode;
}

export function IssueCallout({ severity, title, children }: IssueCalloutProps) {
  return (
    <div className="mb-2-5 issue-callout" data-status={severity}>
      <div className="mono-xs uppercase font-semibold mb-1 callout-title">{title}</div>
      <div className="text-secondary text-xs leading-relaxed">
        {children}
      </div>
    </div>
  );
}
