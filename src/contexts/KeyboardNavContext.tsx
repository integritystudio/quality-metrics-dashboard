import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Shortcut {
  key: string;
  description: string;
  scope: string;
  action: () => void;
}

interface KeyboardNavContextValue {
  shortcuts: Shortcut[];
  register: (key: string, description: string, scope: string, action: () => void) => () => void;
  overlayOpen: boolean;
  toggleOverlay: () => void;
}

const KeyboardNavContext = createContext<KeyboardNavContextValue | null>(null);

export function useShortcut(key: string, description: string, scope: string, action: () => void) {
  const ctx = useContext(KeyboardNavContext);
  useEffect(() => {
    if (!ctx) return;
    return ctx.register(key, description, scope, action);
  }, [ctx, key, description, scope, action]);
}

export function useKeyboardNav() {
  const ctx = useContext(KeyboardNavContext);
  if (!ctx) throw new Error('useKeyboardNav must be used within KeyboardNavProvider');
  return ctx;
}

const IGNORED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

export function KeyboardNavProvider({ children }: { children: ReactNode }) {
  const shortcutsRef = useRef<Shortcut[]>([]);
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const pendingRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const register = useCallback((key: string, description: string, scope: string, action: () => void) => {
    const shortcut: Shortcut = { key, description, scope, action };
    shortcutsRef.current = [...shortcutsRef.current, shortcut];
    setShortcuts([...shortcutsRef.current]);
    return () => {
      shortcutsRef.current = shortcutsRef.current.filter(s => s !== shortcut);
      setShortcuts([...shortcutsRef.current]);
    };
  }, []);

  const toggleOverlay = useCallback(() => setOverlayOpen(o => !o), []);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (IGNORED_TAGS.has((e.target as HTMLElement)?.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;

      if (key === '?') {
        e.preventDefault();
        setOverlayOpen(o => !o);
        return;
      }

      if (key === 'Escape' && overlayOpen) {
        e.preventDefault();
        setOverlayOpen(false);
        return;
      }

      // Two-key combo support (e.g. "g h")
      if (pendingRef.current) {
        const combo = `${pendingRef.current} ${key}`;
        pendingRef.current = null;
        if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
        const match = shortcutsRef.current.find(s => s.key === combo);
        if (match) {
          e.preventDefault();
          match.action();
          return;
        }
      }

      // Check for single-key match
      const single = shortcutsRef.current.find(s => s.key === key);
      if (single) {
        e.preventDefault();
        single.action();
        return;
      }

      // Check if this could be the start of a combo
      const hasCombo = shortcutsRef.current.some(s => s.key.startsWith(`${key} `));
      if (hasCombo) {
        pendingRef.current = key;
        pendingTimerRef.current = setTimeout(() => { pendingRef.current = null; }, 500);
      }
    }

    document.addEventListener('keydown', handleKeydown);
    return () => document.removeEventListener('keydown', handleKeydown);
  }, [overlayOpen]);

  return (
    <KeyboardNavContext.Provider value={{ shortcuts, register, overlayOpen, toggleOverlay }}>
      {children}
    </KeyboardNavContext.Provider>
  );
}
