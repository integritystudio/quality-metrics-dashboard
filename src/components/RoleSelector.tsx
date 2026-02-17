import { useLocation } from 'wouter';
import type { RoleViewType } from '../types.js';

const TABS: Array<{ path: string; label: string; role?: RoleViewType }> = [
  { path: '/', label: 'Dashboard' },
  { path: '/role/executive', label: 'Executive', role: 'executive' },
  { path: '/role/operator', label: 'Operator', role: 'operator' },
  { path: '/role/auditor', label: 'Auditor', role: 'auditor' },
  { path: '/correlations', label: 'Correlations' },
];

export function RoleSelector() {
  const [location, setLocation] = useLocation();

  return (
    <nav className="tab-nav" role="tablist" aria-label="Dashboard views">
      {TABS.map((tab) => {
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
