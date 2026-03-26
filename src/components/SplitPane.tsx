import { useState, useCallback, useRef, useEffect, type ReactNode, type CSSProperties } from 'react';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  initialSplit?: number;
  minPct?: number;
  maxPct?: number;
}

export function SplitPane({ left, right, initialSplit = 50, minPct = 25, maxPct = 75 }: SplitPaneProps) {
  const [splitPct, setSplitPct] = useState(initialSplit);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback(() => { dragging.current = true; }, []);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setSplitPct(Math.max(minPct, Math.min(maxPct, pct)));
    }
    function onMouseUp() { dragging.current = false; }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [minPct, maxPct]);

  return (
    <div ref={containerRef} className="d-flex w-full split-pane">
      <div className="split-pane-panel" style={{ '--split-width': `${splitPct}%` } as CSSProperties}>{left}</div>
      <div
        className="shrink-0 split-pane-divider" role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(splitPct)}
        aria-valuemin={minPct}
        aria-valuemax={maxPct}
        aria-label="Resize panes"
        tabIndex={0}
        onMouseDown={onMouseDown}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') { e.preventDefault(); setSplitPct(p => Math.max(minPct, p - 2)); }
          if (e.key === 'ArrowRight') { e.preventDefault(); setSplitPct(p => Math.min(maxPct, p + 2)); }
        }}
      />
      <div className="split-pane-panel" style={{ '--split-width': `${100 - splitPct}%` } as CSSProperties}>{right}</div>
    </div>
  );
}
