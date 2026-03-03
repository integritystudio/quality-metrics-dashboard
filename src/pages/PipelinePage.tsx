import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { usePipeline } from '../hooks/usePipeline.js';
import { PageShell } from '../components/PageShell.js';
import { LLM_SAMPLE_RATE, SKELETON_HEIGHT_MD, ICON_BADGE_SIZE } from '../lib/constants.js';
import type { Period } from '../types.js';

function T2SamplingStage() {
  return (
    <div
      className="flex-center text-secondary text-xs gap-2-5 mt-3"
      style={{
        padding: 'var(--space-2-5) var(--space-3-5)',
        borderRadius: 'var(--radius)',
        border: '1px dashed var(--border)',
        background: 'var(--bg-surface)',
      }}
    >
      <span className="inline-flex-center justify-center shrink-0 text-2xs font-bold" style={{
        width: ICON_BADGE_SIZE,
        height: ICON_BADGE_SIZE,
        borderRadius: 'var(--radius-full)',
        background: 'var(--accent)',
        color: 'var(--text-on-accent)',
      }}>
        T2
      </span>
      <span>
        <strong style={{ color: 'var(--text-primary)' }}>LLM Sampling</strong>
        {' \u2014 '}
        {LLM_SAMPLE_RATE}% sampled for LLM evaluation (relevance, coherence, faithfulness, hallucination)
      </span>
    </div>
  );
}

export function PipelinePage({ period }: { period: Period }) {
  const { data, isLoading, error } = usePipeline(period);

  return (
    <PageShell isLoading={isLoading} error={error} skeletonHeight={SKELETON_HEIGHT_MD}>
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
