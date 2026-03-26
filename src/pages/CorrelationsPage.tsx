import { useState, useCallback } from 'react';
import { CorrelationHeatmap } from '../components/CorrelationHeatmap.js';
import { SplitPane } from '../components/SplitPane.js';
import { MetricCompare } from '../components/MetricCompare.js';
import { PageShell } from '../components/PageShell.js';
import { ViewSection } from '../components/Section.js';
import { useApiQuery } from '../hooks/useApiQuery.js';
import { API_BASE, SKELETON_HEIGHT_LG, STALE_TIME } from '../lib/constants.js';
import type { CorrelationFeature, Period } from '../types.js';

interface CorrelationsResponse {
  correlations: CorrelationFeature[];
  metrics: string[];
}

export function CorrelationsPage({ period = '30d' }: { period?: Period }) {
  const { data, isLoading, error } = useApiQuery<CorrelationsResponse>(
    ['correlations', period],
    () => `${API_BASE}/api/correlations?period=${period}`,
    { staleTime: STALE_TIME.AGGREGATE },
  );

  const [leftMetric, setLeftMetric] = useState<string | undefined>();
  const [rightMetric, setRightMetric] = useState<string | undefined>();

  const handleCellClick = useCallback((row: string, col: string) => {
    setLeftMetric(row);
    setRightMetric(col);
  }, []);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_LG}>
      {data && (
        <>
          <h2 className="text-lg mb-3">Metric Correlations</h2>
          <div className="card">
            <CorrelationHeatmap
              correlations={data.correlations}
              metrics={data.metrics}
              onCellClick={handleCellClick}
            />
          </div>

          {(leftMetric || rightMetric) && (
            <ViewSection title="Compare Metrics">
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
            </ViewSection>
          )}
        </>
      )}
    </PageShell>
  );
}
