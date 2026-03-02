import type { ReactNode } from 'react';

export interface SimpleAlertItem {
  key: string;
  status: string;
  message: ReactNode;
  meta: ReactNode;
}

export function SimpleAlertList({ items }: { items: SimpleAlertItem[] }) {
  return (
    <ul className="alert-list">
      {items.map((item) => (
        <li key={item.key} className="alert-item" data-status={item.status}>
          <div className="alert-message">{item.message}</div>
          <div className="alert-meta text-secondary text-xs">{item.meta}</div>
        </li>
      ))}
    </ul>
  );
}
