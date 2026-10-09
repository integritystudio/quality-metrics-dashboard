/**
 * The Flutter `_DailyBarChart` (lib/pages/usage_summary_page.dart) in Recharts: one bar per
 * date, ascending, summing every metric; an x label on day 1 and every 5th day; four
 * horizontal grid lines; and, with a monthly limit, a dashed line at its daily share with
 * each bar coloured by its ratio to that line.
 */
import {
  Bar, BarChart, CartesianGrid, Rectangle, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, type BarShapeProps,
} from 'recharts';
import {
  CHART_AXIS_TICK, CHART_COLORS, CHART_DASH_THRESHOLD, CHART_GRID_PROPS, CHART_MARGIN,
  CHART_TOOLTIP_CONTENT_STYLE, CHART_TOOLTIP_LABEL_STYLE,
} from '../../lib/constants.js';
import { USAGE_BAR_CATEGORY_GAP, USAGE_CHART_GRID_LINES, USAGE_CHART_HEIGHT } from '../../lib/admin-customer-constants.js';
import {
  aggregateUsageByDate, dailyBarTone, dailyQuotaLine, usageTickLabel, type DailyUsage, type QuotaTone,
} from '../../lib/admin-customer.js';
import { CUSTOMER_VIEW } from '../../lib/admin-customer-strings.js';
import type { UsageBucket } from '../../lib/validation/admin-customer-schemas.js';

/** `_barColor`: blue500, warning and error in the Flutter theme; the dashboard's chart palette here. */
const TONE_FILL: Record<QuotaTone, string> = {
  normal: CHART_COLORS.line,
  warning: CHART_COLORS.warning,
  danger: CHART_COLORS.critical,
};
/** Grid lines sit at the y ticks; the Flutter chart draws four and no y labels. */
const Y_TICK_COUNT = USAGE_CHART_GRID_LINES + 1;
const UNITS_LABEL = 'units';

interface TonedDailyUsage extends DailyUsage {
  fill: string;
}

interface TonedBarShapeProps extends BarShapeProps {
  payload?: TonedDailyUsage;
}

/** Per-bar colour from the datum (Recharts 3 deprecates `Cell` in favour of `shape`). */
function tonedBar(props: TonedBarShapeProps) {
  return <Rectangle {...props} fill={props.payload?.fill} />;
}

interface DailyUsageChartProps {
  buckets: readonly UsageBucket[];
  /** The org's monthly limit, or 0 when there is none; drives the reference line and bar colours. */
  monthlyLimit: number;
}

export function DailyUsageChart({ buckets, monthlyLimit }: DailyUsageChartProps) {
  const daily: TonedDailyUsage[] = aggregateUsageByDate(buckets)
    .map((d) => ({ ...d, fill: TONE_FILL[dailyBarTone(d.total, monthlyLimit)] }));
  if (daily.length === 0) return null;
  const quotaLine = dailyQuotaLine(monthlyLimit);

  return (
    <div className="customer-chart">
      <p className="customer-chart__title">{CUSTOMER_VIEW.usage.dailyUsage}</p>
      <div role="img" aria-label={`${CUSTOMER_VIEW.usage.dailyUsage}, ${daily.length} days`}>
        <ResponsiveContainer width="100%" height={USAGE_CHART_HEIGHT}>
          <BarChart data={daily} margin={CHART_MARGIN} barCategoryGap={USAGE_BAR_CATEGORY_GAP}>
            <CartesianGrid {...CHART_GRID_PROPS} vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={usageTickLabel}
              interval={0}
              tick={CHART_AXIS_TICK}
              tickLine={false}
              stroke={CHART_COLORS.grid}
            />
            <YAxis hide tickCount={Y_TICK_COUNT} domain={[0, 'dataMax']} />
            <Tooltip
              contentStyle={CHART_TOOLTIP_CONTENT_STYLE}
              labelStyle={CHART_TOOLTIP_LABEL_STYLE}
              formatter={(value) => [typeof value === 'number' ? String(value) : '', UNITS_LABEL]}
              cursor={false}
            />
            {quotaLine !== null && (
              <ReferenceLine y={quotaLine} stroke={CHART_COLORS.text} strokeDasharray={CHART_DASH_THRESHOLD} />
            )}
            <Bar dataKey="total" isAnimationActive={false} shape={tonedBar} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
