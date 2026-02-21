import { useKeyboardNav } from '../contexts/KeyboardNavContext.js';

export function ShortcutOverlay() {
  const { shortcuts, overlayOpen, toggleOverlay } = useKeyboardNav();

  if (!overlayOpen) return null;

  const grouped = new Map<string, Array<{ key: string; description: string }>>();
  for (const s of shortcuts) {
    if (!grouped.has(s.scope)) grouped.set(s.scope, []);
    grouped.get(s.scope)!.push({ key: s.key, description: s.description });
  }

  return (
    <div className="shortcut-overlay-backdrop" onClick={toggleOverlay} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div className="shortcut-overlay" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>Keyboard Shortcuts</h2>
          <button type="button" onClick={toggleOverlay} aria-label="Close" style={{
            background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text-secondary)',
          }}>
            &times;
          </button>
        </div>
        {[...grouped.entries()].map(([scope, items]) => (
          <div key={scope} style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', marginBottom: 8 }}>
              {scope}
            </div>
            {items.map(item => (
              <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span>{item.description}</span>
                <kbd style={{
                  fontFamily: 'var(--font-mono)', fontSize: 11, padding: '2px 6px',
                  borderRadius: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                }}>
                  {item.key}
                </kbd>
              </div>
            ))}
          </div>
        ))}
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
          Press <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>?</kbd> or <kbd style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
