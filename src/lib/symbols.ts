import type { ScoreColorBand } from './quality-utils.js';

export const STATUS_SHAPES: Record<string, string> = {
  healthy: '\u25CF',   // ●
  warning: '\u25B2',   // ▲
  critical: '\u25A0',  // ■
  no_data: '\u25CB',   // ○
};

export const SCORE_SHAPES: Record<ScoreColorBand | 'no_data', string> = {
  excellent: '\u25CF',  // ●
  good: '\u25CF',       // ●
  adequate: '\u25B2',   // ▲
  poor: '\u25A0',       // ■
  failing: '\u25A0',    // ■
  no_data: '\u25CB',    // ○
};

export const CHEVRON_RIGHT = '\u25B6'; // ▶

export const CONFIDENCE_SYMBOLS: Record<string, string> = {
  high: '\u25CF',   // ●
  medium: '\u25D0', // ◐
  low: '\u25CB',    // ○
};
