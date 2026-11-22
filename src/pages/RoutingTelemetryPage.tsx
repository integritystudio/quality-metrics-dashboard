import { useRoutingTelemetry, type RoutingTelemetryStrategyGroup } from '../hooks/useRoutingTelemetry.js';
import { PageShell } from '../components/PageShell.js';
import { PERCENT_MULTIPLIER, SKELETON_HEIGHT_MD, USD_DISPLAY_PRECISION } from '../lib/constants.js';
import { formatPercent, byValueDesc, percentOf } from '../lib/quality-utils.js';
import type { Period } from '../types.js';
import { MonoTableHead, type TableColumn } from '../components/MonoTableHead.js';
import { StatDisplay } from '../components/StatDisplay.js';

const DISTRIBUTION_COUNT_COLUMNS: readonly TableColumn[] = [{ label: 'Count' }, { label: 'Share' }];
const STRATEGY_COLUMNS: readonly TableColumn[] = [
  { label: 'Strategy' }, { label: 'Count' }, { label: 'Fallbacks' }, { label: 'Fallback Rate' },
];

function isStrategyGroup(g: object): g is RoutingTelemetryStrategyGroup {
  return 'strategy' in g && 'fallbackRate' in g;
}

function DistributionTable({ label, distribution, routedSpans }: {
  label: string;
  distribution: Record<string, number>;
  routedSpans: number;
}) {
  if (Object.keys(distribution).length === 0) return null;
  return (
    <div className="card mb-3">
      <h3 className="text-base font-semibold mb-3">{label} Distribution</h3>
      <table className="data-table">
        <MonoTableHead variant="plain" columns={[{ label }, ...DISTRIBUTION_COUNT_COLUMNS]} />
        <tbody>
          {Object.entries(distribution)
            .toSorted(byValueDesc)
            .map(([key, count]) => (
              <tr key={key}>
                <td className="mono">{key}</td>
                <td className="mono">{count}</td>
                <td className="mono">{formatPercent(percentOf(count, routedSpans))}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function RoutingTelemetryPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useRoutingTelemetry(period);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data?.summary.routedSpans === 0 ? (
        <div className="empty-state">
          <h2>No Routing Telemetry</h2>
          <p>No routed spans found for this period. Routing telemetry is recorded when the request model differs from the actual response model.</p>
        </div>
      ) : data ? (
        <>
          <h2 className="text-lg mb-3">Routing Telemetry</h2>

          <div className="card mb-3">
            <div className="flex-wrap gap-8">
              <StatDisplay variant="tile" value={data.summary.routedSpans} label="Routed Spans" />
              <StatDisplay variant="tile" value={formatPercent(data.summary.fallbackRate * PERCENT_MULTIPLIER)} label="Fallback Rate" />
              <StatDisplay variant="tile" value={`$${data.costSavings.toFixed(USD_DISPLAY_PRECISION)}`} label="Cost Savings" />
              <StatDisplay variant="tile" value={data.totalSpansScanned} label="Spans Scanned" />
            </div>
          </div>

          <DistributionTable label="Provider" distribution={data.providerDistribution} routedSpans={data.summary.routedSpans} />
          <DistributionTable label="Model" distribution={data.modelDistribution} routedSpans={data.summary.routedSpans} />

          {data.groups.length > 0 && data.groups.some(g => isStrategyGroup(g)) && (
            <div className="card mb-3">
              <h3 className="text-base font-semibold mb-3">Strategy Breakdown</h3>
              <table className="data-table">
                <MonoTableHead variant="plain" columns={STRATEGY_COLUMNS} />
                <tbody>
                  {data.groups
                    .filter(isStrategyGroup)
                    .toSorted((a, b) => b.count - a.count)
                    .map((g) => (
                      <tr key={g.strategy}>
                        <td className="mono">{g.strategy}</td>
                        <td className="mono">{g.count}</td>
                        <td className="mono">{g.fallbackCount}</td>
                        <td className="mono">{formatPercent(g.fallbackRate * PERCENT_MULTIPLIER)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {data.routingLatency && (
            <div className="card">
              <h3 className="text-base font-semibold mb-3">
                Routing Latency
                <span className="text-secondary text-xs font-normal ml-2">
                  ({data.routingLatency.source === 'classification_time' ? 'classification time' : 'span duration'})
                </span>
              </h3>
              <div className="flex-wrap gap-8">
                <StatDisplay variant="tile" value={`${Math.round(data.routingLatency.p50)}ms`} label="p50" />
                <StatDisplay variant="tile" value={`${Math.round(data.routingLatency.p99)}ms`} label="p99" />
              </div>
            </div>
          )}
        </>
      ) : null}
    </PageShell>
  );
}
