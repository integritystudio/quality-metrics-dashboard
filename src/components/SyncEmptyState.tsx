import { type ReactNode } from 'react';

interface SyncEmptyStateProps {
  title: string;
  description: ReactNode;
}

export function SyncEmptyState({ title, description }: SyncEmptyStateProps) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>
        Data may not have been synced yet. Try again after the next sync cycle.
      </p>
    </div>
  );
}
