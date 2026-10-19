import type { MouseEvent } from 'react';
import { Link } from 'wouter';
import { truncateId } from '../lib/quality-utils.js';
import { ID_DISPLAY_COMPACT_CHARS } from '../lib/constants.js';

export function TruncatedIdLink({ id, href, maxLen = ID_DISPLAY_COMPACT_CHARS, className = 'mono-xs link-accent', onClick }: {
  id: string;
  href: string;
  maxLen?: number;
  className?: string;
  onClick?: (e: MouseEvent) => void;
}) {
  return (
    <Link href={href} className={className} title={id} onClick={onClick}>
      {truncateId(id, maxLen)}
    </Link>
  );
}
