import { format } from 'date-fns';
import { formatTimestamp } from '../lib/quality-utils.js';

const NS_THRESHOLD = 1e15;
const NS_PER_MS = 1_000_000n;

interface TimestampCellProps {
  timestamp: string | number | bigint;
  className?: string;
}

function toIsoString(timestamp: string | number | bigint): string {
  if (typeof timestamp === 'bigint') {
    return new Date(Number(timestamp / NS_PER_MS)).toISOString();
  }
  if (typeof timestamp === 'number') {
    const ms = timestamp >= NS_THRESHOLD ? timestamp / 1_000_000 : timestamp;
    return new Date(ms).toISOString();
  }
  const asNum = Number(timestamp);
  if (Number.isFinite(asNum) && asNum >= NS_THRESHOLD) {
    return new Date(asNum / 1_000_000).toISOString();
  }
  return timestamp;
}

export function TimestampCell({ timestamp, className }: TimestampCellProps) {
  const iso = toIsoString(timestamp);
  const d = new Date(iso);
  const title = isNaN(d.getTime()) ? String(timestamp) : format(d, 'PPp');
  return (
    <span className={className} title={title}>
      {formatTimestamp(iso)}
    </span>
  );
}
