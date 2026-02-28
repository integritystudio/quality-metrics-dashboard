import type { ReactNode } from 'react';
import type { Period } from '../types.js';
import { ShortcutOverlay } from './ShortcutOverlay.js';

const PERIODS: Period[] = ['24h', '7d', '30d'];

export function Layout({
  period,
  onPeriodChange,
  children,
}: {
  period: Period;
  onPeriodChange: (p: Period) => void;
  children: ReactNode;
}) {
  return (
    <div className="dashboard-container">
      <div className="header">
        <h1>Quality Metrics</h1>
        <div className="period-selector">
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`period-btn ${p === period ? 'active' : ''}`}
              onClick={() => onPeriodChange(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      {children}
      <ShortcutOverlay />
    </div>
  );
}
