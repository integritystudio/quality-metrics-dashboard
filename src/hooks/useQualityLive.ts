import { useEffect, useRef, useState } from 'react';
import { API_BASE, POLL_INTERVAL_MS } from '../lib/constants.js';
import type { QualityLiveData } from '../types.js';

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
