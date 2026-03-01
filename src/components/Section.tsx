import { type ReactNode } from 'react';

export interface SectionProps {
  title: string;
  badge?: string;
  health?: 'ok' | 'warn' | 'crit' | 'neutral';
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
      <summary style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 20px',
        background: 'var(--bg-card)',
        borderLeft: `3px solid ${railColor}`,
        borderBottom: '1px solid var(--border-subtle)',
        cursor: 'pointer',
        userSelect: 'none',
        listStyle: 'none',
        transition: 'background 0.15s',
      }}>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: railColor,
          transition: 'transform 0.2s',
          display: 'inline-block',
        }}>▶</span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)',
          flex: 1,
        }}>{title}</span>
        {badge && (
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'var(--bg-elevated)',
            padding: '2px 8px',
            borderRadius: 10,
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
