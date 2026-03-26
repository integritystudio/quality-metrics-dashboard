import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useCalibration, getMetricCalibration, type CalibrationResponse, type MetricCalibration } from '../hooks/useCalibration.js';

interface CalibrationContextValue {
  data: CalibrationResponse | undefined;
  isLoading: boolean;
}

const CalibrationContext = createContext<CalibrationContextValue | null>(null);

export function CalibrationProvider({ children }: { children: ReactNode }) {
  const { data, isLoading } = useCalibration();
  const value = useMemo(() => ({ data, isLoading }), [data, isLoading]);
  return (
    <CalibrationContext.Provider value={value}>
      {children}
    </CalibrationContext.Provider>
  );
}

export function useCalibrationData(): CalibrationContextValue {
  const ctx = useContext(CalibrationContext);
  if (!ctx) {
    throw new Error('useCalibrationData must be used within a CalibrationProvider');
  }
  return ctx;
}

export function useMetricCalibration(metricName: string): MetricCalibration | undefined {
  const ctx = useContext(CalibrationContext);
  if (!ctx) return undefined;
  return getMetricCalibration(ctx.data, metricName);
}
