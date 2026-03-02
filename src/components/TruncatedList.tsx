import type { ReactNode } from 'react';

export function TruncatedList<T>({ items, max, renderItem, total }: {
  items: T[];
  max: number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Server-side total when `items` is already pre-truncated. Defaults to items.length. */
  total?: number;
}) {
  const shown = items.slice(0, max);
  const remainder = (total ?? items.length) - shown.length;
  return (
    <>
      {shown.map(renderItem)}
      {remainder > 0 && (
        <div className="text-muted text-xs mt-1">+{remainder} more</div>
      )}
    </>
  );
}
