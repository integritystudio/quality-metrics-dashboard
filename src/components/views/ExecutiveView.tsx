import { Link } from 'wouter';
import type { ExecutiveView as ExecutiveViewType, CompositeQualityIndex } from '../../types.js';
import { StatusBadge } from '../Indicators.js';
import { CQIHero } from '../CQIHero.js';
import { StatDisplay } from '../StatDisplay.js';
import { MetricGrid } from '../MetricGrid.js';
import { SimpleAlertList } from '../SimpleAlertList.js';
import { ViewSection } from '../Section.js';
import { HealthBanner } from '../HealthBanner.js';
import { plural } from '../../lib/quality-utils.js';

interface ExtendedExecutiveView extends ExecutiveViewType {
  cqi?: CompositeQualityIndex;
}

export function ExecutiveView({ data }: { data: ExtendedExecutiveView }) {
  return (
    <div>
      <HealthBanner status={data.overallStatus} message="Executive Summary">
        <StatDisplay value={data.summary.totalMetrics} label="Total" />
        <StatDisplay value={data.summary.healthyMetrics} label="Healthy" valueClassName="text-healthy" />
        {data.slaCompliantCount !== undefined && (
          <StatDisplay value={`${data.slaCompliantCount}/${data.slaTotalCount}`} label="SLAs Met" />
        )}
      </HealthBanner>

      {data.topIssues.length > 0 && (
        <ViewSection title="Top Issues">
          <SimpleAlertList items={data.topIssues.map((issue: { name: string; displayName: string; status: string; alertCount: number }) => ({
            key: issue.name,
            status: issue.status,
            message: issue.displayName,
            meta: <>Status: {issue.status} &middot; {plural(issue.alertCount, 'alert')}</>,
          }))} />
        </ViewSection>
      )}

      {data.cqi && (
        <div className="view-section">
          <CQIHero cqi={data.cqi} />
        </div>
      )}

      <ViewSection title="Metric Statuses">
        <MetricGrid>
          {data.metricStatuses.map((m: { name: string; displayName: string; status: string }) => (
            <Link key={m.name} href={`/metrics/${m.name}`} className="card card-link d-flex justify-between flex-center p-4">
              <span>{m.displayName}</span>
              <StatusBadge status={m.status} />
            </Link>
          ))}
        </MetricGrid>
      </ViewSection>

      <ViewSection title="Alert Summary">
        <div className="d-flex gap-4">
          {Object.entries(data.alertCounts).map(([severity, count]) => (
            <StatDisplay variant="card" key={severity} value={String(count)} label={severity} />
          ))}
        </div>
      </ViewSection>
    </div>
  );
}
