import type { ReactNode } from 'react';

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
    <details open={defaultOpen} style={{ marginBottom: 2 }}>
      <summary className="flex-center gap-3" style={{
        padding: '12px 20px',
        background: 'var(--bg-card)',
        borderLeft: `3px solid ${railColor}`,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        userSelect: 'none',
        listStyle: 'none',
        transition: 'background 0.15s',
      }}>
        <span className="mono" style={{
          fontSize: 'var(--font-size-2xs)',
          color: railColor,
          transition: 'transform 0.2s',
          display: 'inline-block',
        }}>▶</span>
        <span className="mono-xs text-secondary uppercase font-semibold flex-1">{title}</span>
        {badge && (
          <span className="mono-xs text-muted chip" style={{
            background: 'var(--bg-elevated)',
            border: '1px solid var(--border-subtle)',
          }}>{badge}</span>
        )}
      </summary>
      <div style={{
        padding: '16px 20px 20px',
        background: 'var(--bg-card)',
        borderLeft: `3px solid ${railColor}`,
        borderBottom: '1px solid var(--border-subtle)',
      }}>
        {children}
      </div>
    </details>
  );
}
