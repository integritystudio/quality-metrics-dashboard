import { CHEVRON_RIGHT } from '../lib/symbols.js';

export function ExpandChevron({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      className={`expand-chevron${className ? ` ${className}` : ''}`}
      aria-hidden="true"
      style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}
    >
      {CHEVRON_RIGHT}
    </span>
  );
}
