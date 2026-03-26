import { CHEVRON_RIGHT } from '../lib/symbols.js';

export function ExpandChevron({ expanded, className }: { expanded: boolean; className?: string }) {
  return (
    <span
      className={`expand-chevron${expanded ? ' expand-chevron--open' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      {CHEVRON_RIGHT}
    </span>
  );
}
