import { type ReactNode } from 'react';
import { Link } from 'wouter';

interface PageShellProps {
  isLoading: boolean;
  error: Error | null | undefined;
  skeletonHeight?: number;
  children: ReactNode;
}

export function PageShell({ isLoading, error, skeletonHeight = 300, children }: PageShellProps) {
  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      {isLoading && <div className="card skeleton" style={{ height: skeletonHeight }} />}
      {!isLoading && error != null && (
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      )}
      {!isLoading && error == null && children}
    </div>
  );
}
