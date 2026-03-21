import { useLocation } from 'wouter';
import type { RoleViewType } from '../types.js';
import { useAuth } from '../contexts/AuthContext.js';

const ROLE_TABS: Array<{ path: string; label: string; role: RoleViewType }> = [
  { path: '/role/executive', label: 'Executive', role: 'executive' },
  { path: '/role/operator', label: 'Operator', role: 'operator' },
  { path: '/role/auditor', label: 'Auditor', role: 'auditor' },
];

const STATIC_TABS: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Dashboard' },
  { path: '/correlations', label: 'Correlations' },
  // { path: '/coverage', label: 'Coverage' },  // hidden until data compression (see BACKLOG.md)
  { path: '/pipeline', label: 'Pipeline' },
];

export function RoleSelector() {
  const [location, setLocation] = useLocation();
  const { session } = useAuth();

  const allowedViews = session?.allowedViews ?? [];
  const visibleRoleTabs = ROLE_TABS.filter((t) => allowedViews.includes(t.role));

  const tabs = [
    STATIC_TABS[0],
    ...visibleRoleTabs,
    ...STATIC_TABS.slice(1),
  ];

  return (
    <nav className="tab-nav" role="tablist" aria-label="Dashboard views">
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
    </nav>
  );
}
