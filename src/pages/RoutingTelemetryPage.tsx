import { useRoutingTelemetry, type RoutingTelemetryStrategyGroup } from '../hooks/useRoutingTelemetry.js';
import { PageShell } from '../components/PageShell.js';
import { SKELETON_HEIGHT_MD } from '../lib/constants.js';
import type { Period } from '../types.js';

const PERCENT_MULTIPLIER = 100;

function isStrategyGroup(g: object): g is RoutingTelemetryStrategyGroup {
  return 'strategy' in g && !('pair' in g);
}

export function RoutingTelemetryPage({ period }: { period: Period }) {
  const { data, isLoading, error } = useRoutingTelemetry(period);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
      {data && data.summary.routedSpans === 0 ? (
        <div className="empty-state">
          <h2>No Routing Telemetry</h2>
          <p>No routed spans found for this period. Routing telemetry is recorded when the request model differs from the actual response model.</p>
        </div>
      ) : data ? (
        <>
          <h2 className="text-lg mb-3">Routing Telemetry</h2>

          <div className="card mb-3">
            <div className="flex-wrap gap-8">
              <div className="text-center">
                <div className="mono-xl font-semibold">{data.summary.routedSpans}</div>
                <div className="text-secondary text-xs uppercase">Routed Spans</div>
              </div>
              <div className="text-center">
                <div className="mono-xl font-semibold">
                  {(data.summary.fallbackRate * PERCENT_MULTIPLIER).toFixed(1)}%
                </div>
                <div className="text-secondary text-xs uppercase">Fallback Rate</div>
              </div>
              <div className="text-center">
                <div className="mono-xl font-semibold">${data.costSavings.toFixed(4)}</div>
                <div className="text-secondary text-xs uppercase">Cost Savings</div>
              </div>
              <div className="text-center">
                <div className="mono-xl font-semibold">{data.totalSpansScanned}</div>
                <div className="text-secondary text-xs uppercase">Spans Scanned</div>
              </div>
            </div>
          </div>

          {Object.keys(data.providerDistribution).length > 0 && (
            <div className="card mb-3">
              <h3 className="text-sm font-semibold mb-3">Provider Distribution</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Count</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.providerDistribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([provider, count]) => (
                      <tr key={provider}>
                        <td className="mono">{provider}</td>
                        <td className="mono">{count}</td>
                        <td className="mono">
                          {data.summary.routedSpans > 0
                            ? ((count / data.summary.routedSpans) * PERCENT_MULTIPLIER).toFixed(1) + '%'
                            : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {Object.keys(data.modelDistribution).length > 0 && (
            <div className="card mb-3">
              <h3 className="text-sm font-semibold mb-3">Model Distribution</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Count</th>
                    <th>Share</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.modelDistribution)
                    .sort(([, a], [, b]) => b - a)
                    .map(([model, count]) => (
                      <tr key={model}>
                        <td className="mono">{model}</td>
                        <td className="mono">{count}</td>
                        <td className="mono">
                          {data.summary.routedSpans > 0
                            ? ((count / data.summary.routedSpans) * PERCENT_MULTIPLIER).toFixed(1) + '%'
                            : '—'}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {data.groups.length > 0 && data.groups.some(isStrategyGroup) && (
            <div className="card mb-3">
              <h3 className="text-sm font-semibold mb-3">Strategy Breakdown</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Strategy</th>
                    <th>Count</th>
                    <th>Fallbacks</th>
                    <th>Fallback Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups
                    .filter(isStrategyGroup)
                    .sort((a, b) => b.count - a.count)
                    .map((g) => (
                      <tr key={g.strategy}>
                        <td className="mono">{g.strategy}</td>
                        <td className="mono">{g.count}</td>
                        <td className="mono">{g.fallbackCount}</td>
                        <td className="mono">{(g.fallbackRate * PERCENT_MULTIPLIER).toFixed(1)}%</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {data.routingLatency && (
            <div className="card">
              <h3 className="text-sm font-semibold mb-3">
                Routing Latency
                <span className="text-secondary text-xs font-normal ml-2">
                  ({data.routingLatency.source === 'classification_time' ? 'classification time' : 'span duration'})
                </span>
              </h3>
              <div className="flex-wrap gap-8">
                <div className="text-center">
                  <div className="mono-xl font-semibold">{data.routingLatency.p50.toFixed(0)}ms</div>
                  <div className="text-secondary text-xs uppercase">p50</div>
                </div>
                <div className="text-center">
                  <div className="mono-xl font-semibold">{data.routingLatency.p99.toFixed(0)}ms</div>
                  <div className="text-secondary text-xs uppercase">p99</div>
                </div>
              </div>
            </div>
          )}
        </>
      ) : null}
    </PageShell>
  );
}
