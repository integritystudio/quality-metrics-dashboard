export interface TableColumn {
  label: string;
  align?: 'left' | 'right' | 'center';
}

const ALIGN_CLASS: Record<string, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

export function MonoTableHead({ columns }: { columns: TableColumn[] }) {
  return (
    <thead>
      <tr className="border-b">
        {columns.map(({ label, align = 'right' }, i) => (
          <th key={`${label}-${i}`} className={`text-muted tracking-wide cell-pad nowrap font-semibold ${ALIGN_CLASS[align]}`}>
            {label.toUpperCase()}
          </th>
        ))}
      </tr>
    </thead>
  );
}
