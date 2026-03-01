import type { MetricTrend, ConfidenceIndicator } from '../types.js';

const STATUS_SHAPES: Record<string, string> = {
  healthy: '\u25CF',   // ●
  warning: '\u25B2',   // ▲
  critical: '\u25A0',  // ■
  no_data: '\u25CB',   // ○
};

export function StatusBadge({ status }: { status: string }) {
  const shape = STATUS_SHAPES[status] ?? STATUS_SHAPES.no_data;
  return (
    <span className={`status-badge text-xs ${status}`} aria-label={`Status: ${status}`}>
      {shape} {status}
    </span>
  );
}

export function TrendIndicator({ trend }: { trend?: MetricTrend }) {
  if (!trend) return null;
  const arrow = trend.direction === 'improving' ? '\u2191' : trend.direction === 'degrading' ? '\u2193' : '\u2192';
  const pct = trend.percentChange ?? 0;
  const sign = pct > 0 ? '+' : '';
  return (
    <span className={`trend ${trend.direction}`} aria-label={`Trend: ${trend.direction}, ${sign}${pct.toFixed(1)}%`}>
      {arrow} {sign}{pct.toFixed(1)}%
      {trend.lowSampleWarning && <span title="Low sample count"> *</span>}
    </span>
  );
}

const CONFIDENCE_SYMBOLS: Record<string, string> = {
  high: '\u25CF',   // ●
  medium: '\u25D0', // ◐
  low: '\u25CB',    // ○
};

export function ConfidenceBadge({ confidence }: { confidence?: ConfidenceIndicator }) {
  if (!confidence) return null;
  const symbol = CONFIDENCE_SYMBOLS[confidence.level] ?? '\u25CB';
  return (
    <span className="text-secondary text-xs" aria-label={`Confidence: ${confidence.level}`}>
      {symbol} {confidence.level}
    </span>
  );
}
