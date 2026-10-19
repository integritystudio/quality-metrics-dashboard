import { type ReactNode, type CSSProperties } from 'react';
import { Link } from 'wouter';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';

/** Where the back link goes when a page does not say: home. Existing pages pass nothing and are unchanged. */
export const DEFAULT_BACK_HREF = '/';
export const DEFAULT_BACK_LABEL = 'Back to dashboard';

type PageShellProps = {
  isLoading: boolean;
  error: Error | null | undefined;
  skeletonHeight?: number;
  /** The back link's target; sub-pages of a hub pass the hub so they return to it, not home. */
  backHref?: string;
  backLabel?: string;
  children: ReactNode;
}

export function PageShell({
  isLoading,
  error,
  skeletonHeight = SKELETON_HEIGHT_MD,
  backHref = DEFAULT_BACK_HREF,
  backLabel = DEFAULT_BACK_LABEL,
  children,
}: PageShellProps) {
  return (
    <div>
      <Link href={backHref} className="back-link inline-flex-center">&larr; {backLabel}</Link>
      {isLoading && <div className="card skeleton page-skeleton" style={{ '--skeleton-height': `${skeletonHeight}px` } as CSSProperties} />}
      {!isLoading && error != null && (
        <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>
      )}
      {!isLoading && error == null && children}
    </div>
  );
}
