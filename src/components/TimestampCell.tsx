import { format } from 'date-fns';
import { formatTimestamp } from '../lib/quality-utils.js';

interface TimestampCellProps {
  timestamp: string;
  className?: string;
}

export function TimestampCell({ timestamp, className }: TimestampCellProps) {
  return (
    <span className={className} title={format(new Date(timestamp), 'PPp')}>
      {formatTimestamp(timestamp)}
    </span>
  );
}
