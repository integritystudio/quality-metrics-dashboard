import { Link } from 'wouter';
import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { usePipeline } from '../hooks/usePipeline.js';
import type { Period } from '../types.js';

export function PipelinePage({ period }: { period: Period }) {
  const { data, isLoading, error } = usePipeline(period);

  if (isLoading) return <div className="card skeleton" style={{ height: 300 }} />;
  if (error) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;
  if (!data) return null;

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Evaluation Pipeline</h2>
      <div className="card">
        <PipelineFunnel
          stages={data.stages}
          dropoffs={data.dropoffs}
          overallConversionPercent={data.overallConversionPercent}
        />
      </div>
    </div>
  );
}
