import { createContext, use, useMemo, type ReactNode } from 'react';
import { useCalibration, getMetricCalibration, type MetricCalibration } from '../hooks/useCalibration.js';
import type { CalibrationResponse } from '../lib/validation/dashboard-schemas.js';

type CalibrationContextValue = {
  data: CalibrationResponse | undefined;
}

const CalibrationContext = createContext<CalibrationContextValue | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const { data } = useCalibration();
  const value = useMemo(() => ({ data }), [data]);
  return (
    <CalibrationContext value={value}>
      {children}
    </CalibrationContext>
  );
}

export function useMetricCalibration(metricName: string): MetricCalibration | undefined {
  const ctx = use(CalibrationContext);
  if (!ctx) return undefined;
  return getMetricCalibration(ctx.data, metricName);
}
