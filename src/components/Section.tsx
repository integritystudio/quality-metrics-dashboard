import type { CSSProperties, ReactNode } from 'react';
import { CHEVRON_RIGHT } from '../lib/symbols.js';

/** Non-collapsible view section — wraps .view-section + .section-heading */
export function ViewSection({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="view-section">
      <h3 className="section-heading">{title}</h3>
      {children}
    </div>
  );
}

export type SectionHealth = 'ok' | 'warn' | 'crit' | 'neutral';

export interface SectionProps {
  title: string;
  badge?: string;
  health?: SectionHealth;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function Section({ title, badge, health = 'neutral', defaultOpen = false, children }: SectionProps) {
  const railColor = health === 'ok'
    ? 'var(--status-healthy)'
    : health === 'warn'
    ? 'var(--status-warning)'
    : health === 'crit'
    ? 'var(--status-critical)'
    : 'var(--border-accent)';

  return (
    <details open={defaultOpen} className="mb-1" style={{ '--section-rail-color': railColor } as CSSProperties}>
      <summary
        className="flex-center gap-3 select-none cursor-pointer border-b-subtle list-none section-rail"
        style={{
          padding: 'var(--space-3) var(--space-5)',
          transition: 'background var(--transition-fast)',
        }}
      >
        <span className="mono text-2xs d-inline-block" style={{
          color: railColor,
          transition: 'transform var(--transition-medium)',
        }}>{CHEVRON_RIGHT}</span>
        <span className="mono-xs text-secondary uppercase font-semibold flex-1">{title}</span>
        {badge && (
          <span className="mono-xs text-muted chip chip-badge">{badge}</span>
        )}
      </summary>
      <div
        className="border-b-subtle section-rail"
        style={{ padding: 'var(--space-4) var(--space-5) var(--space-5)' }}
      >
        {children}
      </div>
    </details>
  );
}
