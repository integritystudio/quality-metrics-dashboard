import { Link } from 'wouter';
import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { usePipeline } from '../hooks/usePipeline.js';
import type { Period } from '../types.js';

const LLM_SAMPLE_RATE = 10;

function T2SamplingStage() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderRadius: 6,
        border: '1px dashed var(--border, #2a2a3e)',
        background: 'var(--surface, #1a1a2e)',
        fontSize: 12,
        color: 'var(--text-secondary)',
        marginTop: 12,
      }}
    >
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: '50%',
        background: 'var(--accent, #6366f1)',
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
      }}>
        T2
      </span>
      <span>
        <strong style={{ color: 'var(--text-primary, #e0e0e0)' }}>LLM Sampling</strong>
        {' \u2014 '}
        {LLM_SAMPLE_RATE}% sampled for LLM evaluation (relevance, coherence, faithfulness, hallucination)
      </span>
    </div>
  );
}

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
        <T2SamplingStage />
      </div>
    </div>
  );
}
