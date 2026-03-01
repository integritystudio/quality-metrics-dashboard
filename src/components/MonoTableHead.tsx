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
        {columns.map(({ label, align = 'right' }) => (
          <th key={label} className={`text-muted tracking-wide cell-pad nowrap ${ALIGN_CLASS[align]}`} style={{ fontWeight: 500 }}>
            {label.toUpperCase()}
          </th>
        ))}
      </tr>
    </thead>
  );
}
