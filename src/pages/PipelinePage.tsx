import { PipelineFunnel } from '../components/PipelineFunnel.js';
import { usePipeline } from '../hooks/usePipeline.js';
import { PageShell } from '../components/PageShell.js';
import { LLM_SAMPLE_RATE, SKELETON_HEIGHT_MD } from '../lib/constants.js';
import type { Period } from '../types.js';

function T2SamplingStage() {
  return (
    <div className="flex-center text-secondary text-xs gap-2-5 mt-3 t2-stage-notice">
      <span
        className="inline-flex-center justify-center shrink-0 text-2xs font-bold t2-stage-badge"
      >
        T2
      </span>
      <span>
        <strong className="text-primary">LLM Sampling</strong>
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
