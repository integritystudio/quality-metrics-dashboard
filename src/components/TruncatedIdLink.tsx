import type { MouseEvent } from 'react';
import { Link } from 'wouter';
import { truncateId } from '../lib/quality-utils.js';

export function TruncatedIdLink({ id, href, maxLen = 8, className = 'mono-xs link-accent', onClick }: {
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
