import { useState, Fragment, type CSSProperties } from 'react';
import type { EvaluationResult } from '../types.js';
import {
  createColumnHelper,
  useTable,
  tableFeatures,
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowExpandingFeature,
  rowSortingFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createSortedRowModel,
  sortFn_basic,
  sortFn_datetime,
  flexRender,
  type SortingState,
  type ColumnFiltersState,
  type ExpandedState,
  type SortFn,
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
import { EVAL_TABLE_EXPAND_COL_SIZE } from '../lib/constants.js';
import { EvaluationExpandedRow } from './EvaluationExpandedRow.js';
import { TimestampCell } from './TimestampCell.js';
import { ExpandChevron } from './ExpandChevron.js';
import { ColoredChip } from './Chip.js';
import { ScoreBadge } from './ScoreBadge.js';
import { SortableHeaderCell } from './SortableHeaderCell.js';

export type EvalRow = {
  score: number | null;
  explanation?: string | undefined;
  traceId?: string | undefined;
  timestamp?: string | undefined;
  evaluator?: string | undefined;
  label?: string | undefined;
  /** The label was derived from the score by the dashboard; the producer assigned none. */
  labelDerived?: boolean | undefined;
  evaluatorType?: string | undefined;
  spanId?: string | undefined;
  sessionId?: string | undefined;
  agentName?: string | undefined;
  trajectoryLength?: number | undefined;
  stepScores?: Array<{ step: string | number; score: number; explanation?: string | undefined }> | undefined;
  toolVerifications?: Array<{ toolName: string; toolCorrect: boolean; argsCorrect: boolean; score: number }> | undefined;
}

const DERIVED_LABEL_TITLE = 'Derived from the score by the dashboard; the producer assigned no label';

const CATEGORY_COLORS: Record<LabelFilterCategory, string> = {
  Pass: SCORE_COLORS.excellent,
  Review: SCORE_COLORS.adequate,
  Fail: SCORE_COLORS.failing,
};

const features = tableFeatures({
  columnFilteringFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  rowExpandingFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  expandedRowModel: createExpandedRowModel(),
  sortFns: { basic: sortFn_basic, datetime: sortFn_datetime },
});

type Features = typeof features;

const labelSortFn: SortFn<Features, EvalRow> = (rowA, rowB) => {
  const a = labelToOrdinal(rowA.original.label ?? 'unknown').ordinal;
  const b = labelToOrdinal(rowB.original.label ?? 'unknown').ordinal;
  return a - b;
};

const categoryFilterFn: FilterFn<Features, EvalRow> = (row, _id, filterValue: LabelFilterCategory[]) => {
  if (filterValue.length === 0) return true;
  const category = ordinalToCategory(labelToOrdinal(row.original.label ?? 'unknown').ordinal);
  return filterValue.includes(category);
};

const columnHelper = createColumnHelper<Features, EvalRow>();

const columns = columnHelper.columns([
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
    sortFn: 'basic',
  }),
  columnHelper.accessor('label', {
    header: 'Label',
    cell: (info) => {
      const label = info.getValue() ?? 'unknown';
      const { category } = labelToOrdinal(label);
      const derived = info.row.original.labelDerived === true;
      return (
        <ColoredChip
          color={CATEGORY_COLORS[category]}
          className={derived ? 'font-medium chip-derived' : 'font-medium'}
          title={derived ? DERIVED_LABEL_TITLE : undefined}
        >
          {label}
        </ColoredChip>
      );
    },
    sortFn: labelSortFn,
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
    sortFn: 'datetime',
  }),
]);

export function evalToRow(e: EvaluationResult): EvalRow {
  return {
    score: typeof e.scoreValue === 'number' ? e.scoreValue : null,
    explanation: e.explanation,
    traceId: e.traceId,
    timestamp: String(e.timestamp),
    evaluator: e.evaluator,
    label: e.scoreLabel,
    evaluatorType: e.evaluatorType,
    spanId: e.spanId,
    sessionId: e.sessionId,
    agentName: e.agentName,
    trajectoryLength: e.trajectoryLength,
    stepScores: e.stepScores,
    toolVerifications: e.toolVerifications,
  };
}

export function EvaluationTable({ evaluations }: { evaluations: EvalRow[] }) {
  'use no memo';
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expanded, setExpanded] = useState<ExpandedState>({});

  const table = useTable({
    features,
    data: evaluations,
    columns,
    state: { sorting, columnFilters, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
  });

  const activeCategories: LabelFilterCategory[] =
    (columnFilters.find(f => f.id === 'label')?.value as LabelFilterCategory[] | undefined) ?? [];

  const toggleCategory = (cat: LabelFilterCategory) => {
    const next = activeCategories.includes(cat)
      ? activeCategories.filter((c) => c !== cat)
      : [...activeCategories, cat];
    setColumnFilters(next.length > 0 ? [{ id: 'label', value: next }] : []);
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
              className="eval-filter-chip text-xs font-semibold cursor-pointer"
              style={{ '--chip-color': CATEGORY_COLORS[cat] } as CSSProperties}
              data-active={active || undefined}
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
              {hg.headers.map((header) => (
                <SortableHeaderCell key={header.id} column={header.column} className="select-none">
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </SortableHeaderCell>
              ))}
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
