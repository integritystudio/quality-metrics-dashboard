import { formatTimestamp } from '../lib/quality-utils.js';

interface TimestampCellProps {
  timestamp: string;
  className?: string;
}

export function TimestampCell({ timestamp, className }: TimestampCellProps) {
  return (
    <span className={className} title={new Date(timestamp).toLocaleString()}>
      {formatTimestamp(timestamp)}
    </span>
  );
}
