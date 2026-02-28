import { useState } from 'react';
import { CoverageGrid } from '../components/CoverageGrid.js';
import { useCoverage } from '../hooks/useCoverage.js';
import { PageShell } from '../components/PageShell.js';
import type { Period } from '../types.js';

export function CoveragePage({ period }: { period: Period }) {
  const [inputKey, setInputKey] = useState<'traceId' | 'sessionId'>('traceId');
  const { data, isLoading, error } = useCoverage(period, inputKey);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={400}>
      {data && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
            <h2 className="page-heading" style={{ margin: 0 }}>Evaluation Coverage</h2>
            <select
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value as 'traceId' | 'sessionId')}
              aria-label="Group by"
              style={{ fontSize: 13, padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)' }}
            >
              <option value="traceId">By Trace</option>
              <option value="sessionId">By Session</option>
            </select>
          </div>
          <div className="card">
            <CoverageGrid
              metrics={data.metrics}
              inputs={data.inputs}
              cells={data.cells}
              gaps={data.gaps}
              overallCoveragePercent={data.overallCoveragePercent}
            />
          </div>
        </>
      )}
    </PageShell>
  );
}
