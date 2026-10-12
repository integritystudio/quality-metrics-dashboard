import type { ReactNode } from 'react';
import type { SortDirection } from '@tanstack/react-table';

/** The sorting slice of a TanStack column, whatever other features its table enables. */
export interface SortableColumn {
  getCanSort: () => boolean;
  getIsSorted: () => false | SortDirection;
  getToggleSortingHandler: () => undefined | ((event: unknown) => void);
}

const ARIA_SORT = { asc: 'ascending', desc: 'descending' } as const;
const SORT_INDICATOR = { asc: '↑', desc: '↓' } as const;

interface SortableHeaderCellProps {
  column: SortableColumn;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * A table header cell that sorts its column from a real button, so the sort is reachable
 * by keyboard; `aria-sort` stays on the `<th>`. Unsortable columns render a plain cell.
 */
export function SortableHeaderCell({ column, className, children }: SortableHeaderCellProps) {
  if (!column.getCanSort()) return <th className={className}>{children}</th>;

  const sorted = column.getIsSorted();
  return (
    <th className={className} aria-sort={sorted ? ARIA_SORT[sorted] : 'none'}>
      <button type="button" className="btn-reset th-sort-btn select-none" onClick={column.getToggleSortingHandler()}>
        {children}
        {sorted && <span className="ml-1 text-2xs">{SORT_INDICATOR[sorted]}</span>}
      </button>
    </th>
  );
}
