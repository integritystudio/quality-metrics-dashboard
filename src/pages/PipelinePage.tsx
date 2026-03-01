import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { usePipeline } from '../hooks/usePipeline.js';
import { PageShell } from '../components/PageShell.js';
import { LLM_SAMPLE_RATE } from '../lib/constants.js';
import type { Period } from '../types.js';

function T2SamplingStage() {
  return (
    <div
      className="flex-center text-secondary text-xs"
      style={{
        gap: 10,
        padding: '10px 14px',
        borderRadius: 6,
        border: '1px dashed var(--border, #2a2a3e)',
        background: 'var(--surface, #1a1a2e)',
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
        fontSize: 'var(--font-size-2xs)',
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

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={300}>
      {data && (
        <>
          <h2 className="text-lg mb-3">Evaluation Pipeline</h2>
          <div className="card">
            <PipelineFunnel
              stages={data.stages}
              dropoffs={data.dropoffs}
              overallConversionPercent={data.overallConversionPercent}
            />
            <T2SamplingStage />
          </div>
        </>
      )}
    </PageShell>
  );
}
