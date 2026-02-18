import { MultiDirectoryBackend } from '../../../dist/backends/local-jsonl.js';
import type { EvaluationResult } from '../../../dist/backends/index.js';

let backend: MultiDirectoryBackend | undefined;

function getBackend(): MultiDirectoryBackend {
  if (!backend) {
    backend = new MultiDirectoryBackend(undefined, true);
  }
  return backend;
}

export async function loadEvaluationsByMetric(
  start: string,
  end: string
): Promise<Map<string, EvaluationResult[]>> {
  const be = getBackend();
  const evals = await be.queryEvaluations({ startDate: start, endDate: end, limit: 100_000 });
  const grouped = new Map<string, EvaluationResult[]>();
  for (const ev of evals) {
    const name = ev.evaluationName;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name)!.push(ev);
  }
  return grouped;
}

export async function loadEvaluationsForMetric(
  metricName: string,
  start: string,
  end: string
): Promise<EvaluationResult[]> {
  const be = getBackend();
  return be.queryEvaluations({
    startDate: start,
    endDate: end,
    evaluationName: metricName,
    limit: 10000,
  });
}

export async function loadEvaluationsByTraceId(
  traceId: string
): Promise<EvaluationResult[]> {
  const be = getBackend();
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  return be.queryEvaluations({
    traceId,
    startDate: ninetyDaysAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 1000,
  });
}

export async function checkHealth(): Promise<{ status: string; hasData: boolean }> {
  const be = getBackend();
  const health = await be.healthCheck();
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const evals = await be.queryEvaluations({
    startDate: weekAgo.toISOString(),
    endDate: now.toISOString(),
    limit: 1,
  });
  return { status: health.status, hasData: evals.length > 0 };
}
