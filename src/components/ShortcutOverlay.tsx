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
        <div className="flex-center mb-3" style={{ justifyContent: 'space-between' }}>
          <h2 className="text-md" style={{ margin: 0 }}>Keyboard Shortcuts</h2>
          <button type="button" onClick={toggleOverlay} aria-label="Close" className="text-lg text-secondary" style={{
            background: 'none', border: 'none', cursor: 'pointer',
          }}>
            &times;
          </button>
        </div>
        {[...grouped.entries()].map(([scope, items]) => (
          <div key={scope} className="mb-3">
            <div className="text-secondary mb-1-5 text-xs uppercase font-semibold">
              {scope}
            </div>
            {items.map(item => (
              <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12 }}>
                <span>{item.description}</span>
                <kbd className="mono-xs" style={{
                  padding: '2px 6px',
                  borderRadius: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                }}>
                  {item.key}
                </kbd>
              </div>
            ))}
          </div>
        ))}
        <div className="text-muted text-xs" style={{ marginTop: 8 }}>
          Press <kbd className="mono-xs">?</kbd> or <kbd className="mono-xs">Esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
