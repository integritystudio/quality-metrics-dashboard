/**
 * The quota and usage pages' `LinearProgressIndicator`: a bar whose colour follows the
 * 0.75 / 0.90 thresholds. The tone is a data attribute and the colour lives in theme.css.
 */
import { BarIndicator } from '../BarIndicator.js';
import { PERCENT_MAX, QUOTA_BAR_HEIGHT } from '../../lib/admin-customer-constants.js';
import type { QuotaTone } from '../../lib/admin-customer.js';

interface QuotaBarProps {
  /** 0–1, already clamped. */
  ratio: number;
  tone: QuotaTone;
  /** The progressbar's accessible name; the percentage is its value. */
  label: string;
  percent: number;
}

export function QuotaBar({ ratio, tone, label, percent }: QuotaBarProps) {
  return (
    <div
      className="quota-bar"
      data-tone={tone}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={PERCENT_MAX}
      aria-valuenow={percent}
    >
      <BarIndicator value={ratio * PERCENT_MAX} height={QUOTA_BAR_HEIGHT} />
    </div>
  );
}
