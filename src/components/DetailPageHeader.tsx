import type { ReactNode } from 'react';

interface DetailPageHeaderProps {
  title: string;
  id?: string;
  children?: ReactNode;
}

export function DetailPageHeader({ title, id, children }: DetailPageHeaderProps) {
  return (
    <div className="eval-detail-header">
      <h2 className="text-lg">{title}</h2>
      <div className="eval-detail-meta">
        {id && <span className="mono-xs text-secondary">{id}</span>}
        {children}
      </div>
    </div>
  );
}
