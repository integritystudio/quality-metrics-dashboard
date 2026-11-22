import { useLocation } from 'wouter';
import type { RoleViewType } from '../types.js';
import { useAuth } from '../contexts/AuthContext.js';
import { ROUTE_PATHS, routes } from '../lib/routes.js';

const ROLE_TABS: Array<{ path: string; label: string; role: RoleViewType }> = [
  { path: routes.role('executive'), label: 'Executive', role: 'executive' },
  { path: routes.role('operator'), label: 'Operator', role: 'operator' },
  { path: routes.role('auditor'), label: 'Auditor', role: 'auditor' },
];

const HOME_TAB = { path: ROUTE_PATHS.home, label: 'Dashboard' };

const TRAILING_STATIC_TABS: Array<{ path: string; label: string }> = [
  { path: ROUTE_PATHS.correlations, label: 'Correlations' },
  { path: ROUTE_PATHS.coverage, label: 'Coverage' },
  { path: ROUTE_PATHS.pipeline, label: 'Pipeline' },
  { path: ROUTE_PATHS.qualityLive, label: 'Live Quality' },
];

export function RoleSelector() {
  const [location, setLocation] = useLocation();
  const { session } = useAuth();

  const allowedViews = session?.allowedViews ?? [];
  const visibleRoleTabs = ROLE_TABS.filter((t) => allowedViews.includes(t.role));

  const tabs = [
    HOME_TAB,
    ...visibleRoleTabs,
    ...TRAILING_STATIC_TABS,
  ];

  return (
    <nav aria-label="Dashboard views">
      <div className="tab-nav" role="tablist">
        {tabs.map((tab) => {
          const active = location === tab.path;
          return (
            <button
              key={tab.path}
              role="tab"
              aria-selected={active}
              className="tab-btn"
              onClick={() => setLocation(tab.path)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
