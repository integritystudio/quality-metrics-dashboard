import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CorrelationHeatmap } from '../components/CorrelationHeatmap.js';
import { SplitPane } from '../components/SplitPane.js';
import { MetricCompare } from '../components/MetricCompare.js';
import { PageShell } from '../components/PageShell.js';
import { API_BASE } from '../lib/constants.js';
import type { CorrelationFeature, Period } from '../types.js';

interface CorrelationsResponse {
  correlations: CorrelationFeature[];
  metrics: string[];
}

export function CorrelationsPage({ period = '30d' }: { period?: Period }) {
  const { data, isLoading, error } = useQuery<CorrelationsResponse>({
    queryKey: ['correlations', period],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/correlations?period=${period}`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 2,
  });

  const [leftMetric, setLeftMetric] = useState<string | undefined>();
  const [rightMetric, setRightMetric] = useState<string | undefined>();

  const handleCellClick = useCallback((row: string, col: string) => {
    setLeftMetric(row);
    setRightMetric(col);
  }, []);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={400}>
      {data && (
        <>
          <h2 className="page-heading" style={{ marginBottom: 16 }}>Metric Correlations</h2>
          <div className="card">
            <CorrelationHeatmap
              correlations={data.correlations}
              metrics={data.metrics}
              onCellClick={handleCellClick}
            />
          </div>

          {(leftMetric || rightMetric) && (
            <div className="view-section">
              <h3 className="section-heading">Compare Metrics</h3>
              <div className="card">
                <SplitPane
                  left={
                    <MetricCompare
                      metricName={leftMetric}
                      period={period}
                      availableMetrics={data.metrics}
                      onMetricChange={setLeftMetric}
                    />
                  }
                  right={
                    <MetricCompare
                      metricName={rightMetric}
                      period={period}
                      availableMetrics={data.metrics}
                      onMetricChange={setRightMetric}
                    />
                  }
                />
              </div>
            </div>
          )}
        </>
      )}
    </PageShell>
  );
}
