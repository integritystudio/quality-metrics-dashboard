import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { SPLIT_PANE_DIVIDER_WIDTH, SPLIT_PANE_MIN_HEIGHT } from '../lib/constants.js';

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
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [minPct, maxPct]);

  return (
    <div ref={containerRef} className="d-flex w-full" style={{ minHeight: SPLIT_PANE_MIN_HEIGHT }}>
      <div style={{ width: `${splitPct}%`, overflow: 'auto' }}>{left}</div>
      <div
        className="shrink-0" role="separator"
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
        style={{
          width: SPLIT_PANE_DIVIDER_WIDTH,
          cursor: 'col-resize',
          background: 'var(--border)',
          borderRadius: 'var(--radius-bar)',
        }}
      />
      <div style={{ width: `${100 - splitPct}%`, overflow: 'auto' }}>{right}</div>
    </div>
  );
}
