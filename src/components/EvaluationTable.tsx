import { useState, Fragment } from 'react';
import type { EvaluationResult } from '../types.js';
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
  truncateText,
  formatScore,
  SCORE_COLORS,
  type LabelFilterCategory,
} from '../lib/quality-utils.js';
import { EVAL_TABLE_EXPAND_COL_SIZE, EVAL_FILTER_INACTIVE_OPACITY } from '../lib/constants.js';
import { EvaluationExpandedRow } from './EvaluationExpandedRow.js';
import { TimestampCell } from './TimestampCell.js';
import { ExpandChevron } from './ExpandChevron.js';
import { ColoredChip } from './Chip.js';
import { ScoreBadge } from './ScoreBadge.js';

export interface EvalRow {
  score: number | null;
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

const CATEGORY_COLORS: Record<LabelFilterCategory, string> = {
  Pass: SCORE_COLORS.excellent,
  Review: SCORE_COLORS.adequate,
  Fail: SCORE_COLORS.failing,
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

const columnHelper = createColumnHelper<EvalRow>();

const columns = [
  columnHelper.display({
    id: 'expand',
    header: '',
    cell: ({ row }) => (
      <button
        type="button"
        className="cursor-pointer btn-reset btn-expand"
        onClick={row.getToggleExpandedHandler()}
        aria-label={row.getIsExpanded() ? 'Collapse row' : 'Expand row'}
      >
        <ExpandChevron expanded={row.getIsExpanded()} className="text-secondary text-xs" />
      </button>
    ),
    size: EVAL_TABLE_EXPAND_COL_SIZE,
  }),
  columnHelper.accessor('score', {
    header: 'Score',
    cell: (info) => {
      const row = info.row.original;
      return (
        <ScoreBadge
          score={info.getValue()}
          metricName="score"
          label={formatScore(info.getValue())}
          evaluator={row.evaluator}
          evaluatorType={row.evaluatorType}
          explanation={row.explanation}
          traceId={row.traceId}
        />
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
        <ColoredChip color={CATEGORY_COLORS[category]} className="font-medium">
          {label}
        </ColoredChip>
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
        <ColoredChip color={CATEGORY_COLORS[category]} className="font-semibold">
          {category}
        </ColoredChip>
      );
    },
  }),
  columnHelper.accessor('explanation', {
    header: 'Explanation',
    cell: (info) => {
      const text = info.getValue() ?? '-';
      return (
        <span className="explanation truncate" title={text}>
          {truncateText(text, 60)}
        </span>
      );
    },
    enableSorting: false,
  }),
  columnHelper.accessor('evaluator', {
    header: 'Evaluator',
    cell: (info) => (
      <span className="mono-xs">
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
        <TimestampCell timestamp={ts} />
      );
    },
    sortingFn: 'datetime',
  }),
];

export function evalToRow(e: EvaluationResult): EvalRow {
  return {
    score: typeof e.scoreValue === 'number' ? e.scoreValue : null,
    explanation: e.explanation,
    traceId: e.traceId,
    timestamp: e.timestamp,
    evaluator: e.evaluator,
    label: e.scoreLabel,
    evaluatorType: e.evaluatorType,
    spanId: e.spanId,
    sessionId: e.sessionId,
    agentName: e.agentName,
    trajectoryLength: e.trajectoryLength,
    stepScores: e.stepScores as EvalRow['stepScores'],
    toolVerifications: e.toolVerifications as EvalRow['toolVerifications'],
  };
}

export function EvaluationTable({ evaluations }: { evaluations: EvalRow[] }) {
  'use no memo';
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [activeCategories, setActiveCategories] = useState<LabelFilterCategory[]>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table returns unstable function refs; React Compiler compatibility is a known upstream issue. Component re-renders on data change so no stale refs escape.
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
      <div className="d-flex mb-3 gap-1-5">
        {(['Pass', 'Review', 'Fail'] as const).map((cat) => {
          const active = activeCategories.includes(cat);
          return (
            <button
              key={cat}
              type="button"
              onClick={() => toggleCategory(cat)}
              className="text-xs font-semibold cursor-pointer"
              style={{
                padding: 'var(--space-1) var(--space-3)',
                borderRadius: 'var(--radius)',
                border: `1px solid ${CATEGORY_COLORS[cat]}`,
                backgroundColor: active ? `${CATEGORY_COLORS[cat]}30` : 'transparent',
                color: CATEGORY_COLORS[cat],
                opacity: active ? 1 : EVAL_FILTER_INACTIVE_OPACITY,
                transition: 'opacity var(--transition-fast), background-color var(--transition-fast)',
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>
      <table className="data-table eval-table">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((header) => {
                const canSort = header.column.getCanSort();
                return (
                  <th
                    key={header.id}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    className={`select-none${canSort ? ' cursor-pointer' : ''}`}
                    aria-sort={canSort ? sortDir(header.id) : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {canSort && (
                      <span className="ml-1 text-2xs">
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
              <td colSpan={table.getVisibleLeafColumns().length} className="text-muted text-center p-4">
                No evaluations match the current filter.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
