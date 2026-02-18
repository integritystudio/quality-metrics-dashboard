import { useState } from 'react';
import { Link } from 'wouter';
import { CoverageGrid } from '../components/CoverageGrid.js';
import { useCoverage } from '../hooks/useCoverage.js';
import type { Period } from '../types.js';

export function CoveragePage({ period }: { period: Period }) {
  const [inputKey, setInputKey] = useState<'traceId' | 'sessionId'>('traceId');
  const { data, isLoading, error } = useCoverage(period, inputKey);

  if (isLoading) return <div className="card skeleton" style={{ height: 400 }} />;
  if (error) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;
  if (!data) return null;

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Evaluation Coverage</h2>
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
    </div>
  );
}
