import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** Single-char key (e.g. "1") or two-key combo (e.g. "g h"). A single key MUST NOT also be a combo prefix. */
type ShortcutKey = string;
/** Two-key combo: `"prefix suffix"` */
type ComboKey = `${string} ${string}`;

interface Shortcut {
  key: ShortcutKey;
  description: string;
  scope: string;
  action: () => void;
}

function isComboKey(key: string): key is ComboKey {
  return key.includes(' ');
}

function comboPrefix(key: ComboKey): string {
  return key.split(' ')[0];
}

interface KeyboardNavContextValue {
  shortcuts: Shortcut[];
  register: (key: ShortcutKey, description: string, scope: string, action: () => void) => () => void;
  overlayOpen: boolean;
  toggleOverlay: () => void;
}

const KeyboardNavContext = createContext<KeyboardNavContextValue | null>(null);

export function useShortcut(key: ShortcutKey, description: string, scope: string, action: () => void) {
  const ctx = useContext(KeyboardNavContext);
  if (!ctx) throw new Error('useShortcut must be used within KeyboardNavProvider');
  const { register } = ctx;
  const actionRef = useRef(action);
  useEffect(() => { actionRef.current = action; });
  const stableAction = useCallback(() => actionRef.current(), []);
  useEffect(() => register(key, description, scope, stableAction), [register, key, description, scope, stableAction]);
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
  const overlayOpenRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const register = useCallback((key: ShortcutKey, description: string, scope: string, action: () => void) => {
    const existing = shortcutsRef.current;
    const duplicate = existing.find(s => s.key === key);
    if (duplicate) throw new Error(`Shortcut conflict: "${key}" is already registered (${duplicate.description})`);
    if (isComboKey(key)) {
      const prefix = comboPrefix(key);
      const conflict = existing.find(s => s.key === prefix);
      if (conflict) throw new Error(`Shortcut conflict: combo "${key}" clashes with single-key "${prefix}" (${conflict.description})`);
    } else {
      const conflict = existing.find(s => isComboKey(s.key) && comboPrefix(s.key) === key);
      if (conflict) throw new Error(`Shortcut conflict: single-key "${key}" clashes with combo "${conflict.key}" (${conflict.description})`);
    }
    const shortcut: Shortcut = { key, description, scope, action };
    const next = [...existing, shortcut];
    shortcutsRef.current = next;
    setShortcuts(next);
    return () => {
      const filtered = shortcutsRef.current.filter(s => s !== shortcut);
      shortcutsRef.current = filtered;
      setShortcuts(filtered);
    };
  }, []);

  const toggleOverlay = useCallback(() => {
    setOverlayOpen(o => {
      overlayOpenRef.current = !o;
      return !o;
    });
  }, []);

  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (IGNORED_TAGS.has((e.target as HTMLElement)?.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const key = e.key;

      if (key === '?') {
        e.preventDefault();
        setOverlayOpen(o => {
          overlayOpenRef.current = !o;
          return !o;
        });
        return;
      }

      if (key === 'Escape' && overlayOpenRef.current) {
        e.preventDefault();
        overlayOpenRef.current = false;
        setOverlayOpen(false);
        return;
      }

      // Two-key combo support (e.g. "g h")
      if (pendingRef.current) {
        const combo = `${pendingRef.current} ${key}`;
        pendingRef.current = null;
        if (pendingTimerRef.current) {
          clearTimeout(pendingTimerRef.current);
          pendingTimerRef.current = null;
        }
        const match = shortcutsRef.current.find(s => s.key === combo);
        if (match) {
          e.preventDefault();
          match.action();
          return;
        }
      }

      const single = shortcutsRef.current.find(s => s.key === key);
      if (single) {
        e.preventDefault();
        single.action();
        return;
      }

      const hasCombo = shortcutsRef.current.some(s => s.key.startsWith(`${key} `));
      if (hasCombo) {
        pendingRef.current = key;
        pendingTimerRef.current = setTimeout(() => { pendingRef.current = null; }, 500);
      }
    }

    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
      if (pendingTimerRef.current) clearTimeout(pendingTimerRef.current);
    };
  }, []);

  const value = useMemo<KeyboardNavContextValue>(
    () => ({ shortcuts, register, overlayOpen, toggleOverlay }),
    [shortcuts, register, overlayOpen, toggleOverlay],
  );

  return (
    <KeyboardNavContext.Provider value={value}>
      {children}
    </KeyboardNavContext.Provider>
  );
}
