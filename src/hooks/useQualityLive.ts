import { useEffect, useRef, useState } from 'react';

const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3001' : '');

const POLL_INTERVAL_MS = 30_000;

interface LiveMetric {
  name: string;
  score: number;
  evaluatorType: string;
  timestamp: string;
}

export interface QualityLiveData {
  metrics: LiveMetric[];
  sessionCount: number;
  lastUpdated: string;
}

export interface UseQualityLiveResult {
  data: QualityLiveData | null;
  isLoading: boolean;
  error: Error | null;
}

export function useQualityLive(): UseQualityLiveResult {
  const [data, setData] = useState<QualityLiveData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchLive() {
      try {
        const res = await fetch(`${API_BASE}/api/quality/live`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const json = await res.json() as QualityLiveData;
        if (!cancelled) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    function startPolling() {
      fetchLive();
      timerRef.current = setInterval(fetchLive, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    }

    startPolling();
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  return { data, isLoading, error };
}
