import type { ReactNode } from 'react';

interface EmptyStateProps {
  message?: string;
  title?: string;
  description?: ReactNode;
  showSyncHint?: boolean;
}

export function EmptyState({ message, title, description, showSyncHint }: EmptyStateProps) {
  if (title || description) {
    return (
      <div className="empty-state">
        {title && <h2>{title}</h2>}
        {description && <p>{description}</p>}
        {showSyncHint && (
          <p className="text-muted text-xs mt-2">
            Data may not have been synced yet. Try again after the next sync cycle.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="text-muted text-center p-4">
      {message}
    </div>
  );
}
