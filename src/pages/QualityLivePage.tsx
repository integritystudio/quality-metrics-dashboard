import { useQualityLive } from '../hooks/useQualityLive.js';
import { PageShell } from '../components/PageShell.js';
import { QualityLiveIndicator } from '../components/QualityLiveIndicator.js';
import { plural } from '../lib/quality-utils.js';

export function QualityLivePage() {
  const { data, isLoading, error } = useQualityLive();

  return (
    <PageShell isLoading={isLoading} error={error}>
      {data && data.metrics.length > 0 ? (
        <>
          <h2 className="text-lg mb-3">Live Quality</h2>
          <p className="text-secondary text-xs mb-3">
            Latest score per metric over the last 24 hours, across {plural(data.sessionCount, 'session')}.
          </p>
          <QualityLiveIndicator />
        </>
      ) : (
        <div className="empty-state">
          <h2>No Live Quality Data</h2>
          <p>No evaluations in the last 24 hours. Run the data pipeline to populate them.</p>
        </div>
      )}
    </PageShell>
  );
}
