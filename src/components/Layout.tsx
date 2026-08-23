import { useCallback, useState, type ReactNode } from 'react';
import type { Period } from '../types.js';
import { ShortcutOverlay } from './ShortcutOverlay.js';
import { useAuth } from '../contexts/AuthContext.js';

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
  const { signOut } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  // On success Auth0 redirects away, so the flag only needs resetting on
  // failure — otherwise the button would re-enable mid-redirect.
  const handleLogout = useCallback(() => {
    setIsLoggingOut(true);
    void signOut().catch(() => setIsLoggingOut(false));
  }, [signOut]);
  return (
    <div className="dashboard-container">
      <div className="header flex-center">
        <h1>Quality Metrics</h1>
        <div className="header-actions">
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
          <button className="btn-xs logout-btn" disabled={isLoggingOut} onClick={handleLogout}>
            {isLoggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </div>
      {children}
      <ShortcutOverlay />
    </div>
  );
}
