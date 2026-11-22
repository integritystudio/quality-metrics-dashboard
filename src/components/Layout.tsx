import { useCallback, useState, type ReactNode } from 'react';
import type { Period } from '../types.js';
import { DATA_GATED_PERIOD } from '../lib/constants.js';
import { PERIOD_KEYS } from '../lib/periods.js';
import { ShortcutOverlay } from './ShortcutOverlay.js';
import { useAuth } from '../contexts/AuthContext.js';
import { Shortcut, SHORTCUT_SCOPE } from '../contexts/KeyboardNavContext.js';
import { useOfferPeriod } from '../hooks/useDashboard.js';
import { AccountBadge } from './AccountBadge.js';

const GATED_PERIOD_SHORTCUT_KEY = '4';

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
  // Kept while selected, so a period whose data lapses does not strand the user on a hidden button.
  const showGatedPeriod = useOfferPeriod(DATA_GATED_PERIOD) || period === DATA_GATED_PERIOD;
  const periods = showGatedPeriod ? PERIOD_KEYS : PERIOD_KEYS.filter((p) => p !== DATA_GATED_PERIOD);
  return (
    <div className="dashboard-container">
      <div className="header flex-center">
        <h1>Quality Metrics</h1>
        <div className="header-actions">
          <div className="period-selector">
            {periods.map((p) => (
              <button
                key={p}
                className={`period-btn ${p === period ? 'active' : ''}`}
                onClick={() => onPeriodChange(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <AccountBadge />
          <button className="btn-xs logout-btn" disabled={isLoggingOut} onClick={handleLogout}>
            {isLoggingOut ? 'Logging out…' : 'Log out'}
          </button>
        </div>
      </div>
      {children}
      {/* Registered only while the gated period's button is shown, so the key never selects a hidden period. */}
      {showGatedPeriod && (
        <Shortcut
          shortcutKey={GATED_PERIOD_SHORTCUT_KEY}
          description={`Switch to ${DATA_GATED_PERIOD}`}
          scope={SHORTCUT_SCOPE.PERIOD}
          action={() => onPeriodChange(DATA_GATED_PERIOD)}
        />
      )}
      <ShortcutOverlay />
    </div>
  );
}
