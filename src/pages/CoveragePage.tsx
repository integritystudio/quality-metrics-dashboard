import { useState } from 'react';
import { CoverageGrid } from '../components/CoverageGrid.js';
import { useCoverage } from '../hooks/useCoverage.js';
import { PageShell } from '../components/PageShell.js';
import { DEFAULT_INPUT_KEY, SKELETON_HEIGHT_LG, type InputKey } from '../lib/constants.js';
import type { Period } from '../types.js';

export function CoveragePage({ period }: { period: Period }) {
  const [inputKey, setInputKey] = useState<InputKey>(DEFAULT_INPUT_KEY);
  const { data, isLoading, error } = useCoverage(period, inputKey);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_LG}>
      {data && (
        <>
          <div className="flex-center mb-3 gap-4">
            <h2 className="text-lg m-0">Evaluation Coverage</h2>
            <select
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value as InputKey)}
              aria-label="Group by"
              className="text-xs form-select"
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
