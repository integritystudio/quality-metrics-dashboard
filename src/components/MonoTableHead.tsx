export type TableColumn = {
  label: string;
  align?: 'left' | 'right' | 'center';
}

const ALIGN_CLASS: Record<NonNullable<TableColumn['align']>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

const MONO_HEADER_CELL_CLASS = 'text-muted uppercase cell-pad nowrap font-semibold';

type MonoTableHeadProps = {
  columns: readonly TableColumn[];
  /** `plain` leaves the cells to the table's own stylesheet (`.data-table th`) and aligns only when asked. */
  variant?: 'mono' | 'plain';
}

export function MonoTableHead({ columns, variant = 'mono' }: MonoTableHeadProps) {
  if (variant === 'plain') {
    return (
      <thead>
        <tr>
          {columns.map(({ label, align }) => (
            <th key={label} className={align ? ALIGN_CLASS[align] : undefined}>{label}</th>
          ))}
        </tr>
      </thead>
    );
  }
  return (
    <thead>
      <tr className="border-b">
        {columns.map(({ label, align = 'right' }) => (
          <th key={label} className={`${MONO_HEADER_CELL_CLASS} ${ALIGN_CLASS[align]}`}>
            {label}
          </th>
        ))}
      </tr>
    </thead>
  );
}
