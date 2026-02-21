import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';

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
    <div ref={containerRef} style={{ display: 'flex', width: '100%', minHeight: 300 }}>
      <div style={{ width: `${splitPct}%`, overflow: 'auto' }}>{left}</div>
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 6,
          cursor: 'col-resize',
          background: 'var(--border)',
          flexShrink: 0,
          borderRadius: 3,
        }}
      />
      <div style={{ width: `${100 - splitPct}%`, overflow: 'auto' }}>{right}</div>
    </div>
  );
}
