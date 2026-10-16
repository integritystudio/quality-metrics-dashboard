import { format } from 'date-fns';
import { formatTimestamp } from '../lib/quality-utils.js';
import { timestampToMs } from '../lib/timestamps.js';

type TimestampCellProps = {
  timestamp: string | number | bigint;
  className?: string;
}

function toIsoString(timestamp: string | number | bigint): string {
  const ms = timestampToMs(timestamp);
  return Number.isNaN(ms) ? String(timestamp) : new Date(ms).toISOString();
}

export function TimestampCell({ timestamp, className }: TimestampCellProps) {
  const iso = toIsoString(timestamp);
  const d = new Date(iso);
  const title = Number.isNaN(d.getTime()) ? String(timestamp) : format(d, 'PPp');
  return (
    <span className={className} title={title}>
      {formatTimestamp(iso)}
    </span>
  );
}
