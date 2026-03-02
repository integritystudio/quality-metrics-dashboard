import type { Period, CoverageHeatmap } from '../types.js';
import { API_BASE, DEFAULT_INPUT_KEY, type InputKey } from '../lib/constants.js';
import { useApiQuery } from './useApiQuery.js';

export type CoverageResponse = CoverageHeatmap & { period: string };

export function useCoverage(period: Period, inputKey: InputKey = DEFAULT_INPUT_KEY) {
  return useApiQuery<CoverageResponse>(
    ['coverage', period, inputKey],
    () => `${API_BASE}/api/coverage?${new URLSearchParams({ period, inputKey })}`,
  );
}
