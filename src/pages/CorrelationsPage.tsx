import { useQuery } from '@tanstack/react-query';
import { Link } from 'wouter';
import { CorrelationHeatmap } from '../components/CorrelationHeatmap.js';
import type { CorrelationFeature } from '../types.js';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

interface CorrelationsResponse {
  correlations: CorrelationFeature[];
  metrics: string[];
}

export function CorrelationsPage() {
  const { data, isLoading, error } = useQuery<CorrelationsResponse>({
    queryKey: ['correlations'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/api/correlations`);
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return res.json();
    },
    staleTime: 60_000,
    retry: 2,
  });

  if (isLoading) return <div className="card skeleton" style={{ height: 400 }} />;
  if (error) return <div className="error-state"><h2>Failed to load</h2><p>{error.message}</p></div>;
  if (!data) return null;

  return (
    <div>
      <Link href="/" className="back-link">&larr; Back to dashboard</Link>
      <h2 style={{ fontSize: 18, marginBottom: 16 }}>Metric Correlations</h2>
      <div className="card">
        <CorrelationHeatmap correlations={data.correlations} metrics={data.metrics} />
      </div>
    </div>
  );
}
