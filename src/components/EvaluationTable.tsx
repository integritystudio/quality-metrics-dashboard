import { useState, Fragment } from 'react';
import {
  createColumnHelper,
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  flexRender,
  type SortingState,
  type ColumnFiltersState,
  type ExpandedState,
  type SortingFn,
  type FilterFn,
} from '@tanstack/react-table';
import {
  labelToOrdinal,
  ordinalToCategory,
  scoreColorBand,
  type LabelFilterCategory,
} from '../lib/quality-utils.js';
import { EvaluationExpandedRow } from './EvaluationExpandedRow.js';

export interface EvalRow {
  score: number;
  explanation?: string;
  traceId?: string;
  timestamp?: string;
  evaluator?: string;
  label?: string;
  evaluatorType?: string;
  spanId?: string;
  sessionId?: string;
  agentName?: string;
  trajectoryLength?: number;
  stepScores?: Array<{ step: string | number; score: number; explanation?: string }>;
  toolVerifications?: Array<{ toolName: string; toolCorrect: boolean; argsCorrect: boolean; score: number }>;
}

const SCORE_COLORS: Record<string, string> = {
  excellent: '#26d97f',
  good: '#34d399',
  adequate: '#e5a00d',
  poor: '#f97316',
  failing: '#f04438',
};

const CATEGORY_COLORS: Record<LabelFilterCategory, string> = {
  Pass: '#26d97f',
  Review: '#e5a00d',
  Fail: '#f04438',
};

const labelSortFn: SortingFn<EvalRow> = (rowA, rowB) => {
  const a = labelToOrdinal(rowA.original.label ?? 'unknown').ordinal;
  const b = labelToOrdinal(rowB.original.label ?? 'unknown').ordinal;
  return a - b;
};

const categoryFilterFn: FilterFn<EvalRow> = (row, _id, filterValue: LabelFilterCategory[]) => {
  if (!filterValue || filterValue.length === 0) return true;
  const category = ordinalToCategory(labelToOrdinal(row.original.label ?? 'unknown').ordinal);
  return filterValue.includes(category);
};

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return ts || '-';
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

const columnHelper = createColumnHelper<EvalRow>();

const columns = [
  columnHelper.display({
    id: 'expand',
    header: '',
    cell: ({ row }) => (
      <button
        type="button"
        onClick={row.getToggleExpandedHandler()}
        aria-label={row.getIsExpanded() ? 'Collapse row' : 'Expand row'}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 6px',
          fontSize: 12,
          color: 'var(--text-secondary)',
          transition: 'transform 0.15s',
          transform: row.getIsExpanded() ? 'rotate(90deg)' : 'rotate(0deg)',
        }}
      >
        &#9654;
      </button>
    ),
    size: 32,
  }),
  columnHelper.accessor('score', {
    header: 'Score',
    cell: (info) => {
      const v = info.getValue();
      const band = scoreColorBand(v, 'maximize');
      return (
        <span style={{ color: SCORE_COLORS[band], fontWeight: 600 }}>
          {v.toFixed(4)}
        </span>
      );
    },
    sortingFn: 'basic',
  }),
  columnHelper.accessor('label', {
    header: 'Label',
    cell: (info) => {
      const label = info.getValue() ?? 'unknown';
      const { category } = labelToOrdinal(label);
      return (
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 500,
            backgroundColor: `${CATEGORY_COLORS[category]}20`,
            color: CATEGORY_COLORS[category],
          }}
        >
          {label}
        </span>
      );
    },
    sortingFn: labelSortFn,
    filterFn: categoryFilterFn,
  }),
  columnHelper.display({
    id: 'category',
    header: 'Category',
    cell: (info) => {
      const label = info.row.original.label ?? 'unknown';
      const category = ordinalToCategory(labelToOrdinal(label).ordinal);
      return (
        <span
          style={{
            display: 'inline-block',
            padding: '2px 8px',
            borderRadius: 10,
            fontSize: 11,
            fontWeight: 600,
            backgroundColor: `${CATEGORY_COLORS[category]}20`,
            color: CATEGORY_COLORS[category],
          }}
        >
          {category}
        </span>
      );
    },
  }),
  columnHelper.accessor('explanation', {
    header: 'Explanation',
    cell: (info) => {
      const text = info.getValue() ?? '-';
      return (
        <span className="explanation" title={text}>
          {truncate(text, 60)}
        </span>
      );
    },
    enableSorting: false,
  }),
  columnHelper.accessor('evaluator', {
    header: 'Evaluator',
    cell: (info) => (
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {info.getValue() ?? '-'}
      </span>
    ),
    enableSorting: false,
  }),
  columnHelper.accessor('timestamp', {
    header: 'Timestamp',
    cell: (info) => {
      const ts = info.getValue();
      if (!ts) return '-';
      return (
        <span title={new Date(ts).toLocaleString()}>
          {formatTimestamp(ts)}
        </span>
      );
    },
    sortingFn: 'datetime',
  }),
];

export function EvaluationTable({ evaluations }: { evaluations: EvalRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [activeCategories, setActiveCategories] = useState<LabelFilterCategory[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const table = useReactTable({
    data: evaluations,
    columns,
    state: { sorting, columnFilters, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  });

  const toggleCategory = (cat: LabelFilterCategory) => {
    const next = activeCategories.includes(cat)
      ? activeCategories.filter((c) => c !== cat)
      : [...activeCategories, cat];
    setActiveCategories(next);
    setColumnFilters(
      next.length > 0 ? [{ id: 'label', value: next }] : [],
    );
  };

  const sortDir = (colId: string): 'ascending' | 'descending' | 'none' => {
    const s = sorting.find((entry) => entry.id === colId);
    if (!s) return 'none';
    return s.desc ? 'descending' : 'ascending';
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        {(['Pass', 'Review', 'Fail'] as const).map((cat) => {
          const active = activeCategories.includes(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => toggleCategory(cat)}
              style={{
                padding: '4px 12px',
                borderRadius: 6,
                border: `1px solid ${CATEGORY_COLORS[cat]}`,
                backgroundColor: active ? `${CATEGORY_COLORS[cat]}30` : 'transparent',
                color: CATEGORY_COLORS[cat],
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                opacity: active ? 1 : 0.6,
                transition: 'opacity 0.15s, background-color 0.15s',
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>
      <table className="eval-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    style={{ cursor: canSort ? 'pointer' : 'default', userSelect: 'none' }}
                    aria-sort={canSort ? sortDir(header.id) : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {canSort && (
                      <span style={{ marginLeft: 4, fontSize: 10 }}>
                        {{ asc: ' ^', desc: ' v' }[header.column.getIsSorted() as string] ?? ''}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <Fragment key={row.id}>
              <tr className={row.getIsExpanded() ? 'eval-row-expanded' : ''}>
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
              {row.getIsExpanded() && (
                <tr className="eval-expanded-panel">
                  <td colSpan={row.getVisibleCells().length}>
                    <EvaluationExpandedRow row={row.original} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
          {table.getRowModel().rows.length === 0 && (
            <tr>
              <td colSpan={table.getVisibleLeafColumns().length} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 16 }}>
                No evaluations match the current filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
