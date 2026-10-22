#!/usr/bin/env tsx
/**
 * Scores a judge-hallucination-eval.ts run against an earlier run's reference
 * labels (HALLUCINATION-METHOD-RESEARCH). A re-run with a revised
 * HALLUCINATION_CRITERIA re-judges its own reference with that rubric, so only
 * the earlier labels are comparable across runs.
 *
 * For each configuration: MAE in grade steps, recall on the turns the labels flag
 * (any fabrication), and specificity on the turns they leave clean. Beside them,
 * the best constant grade's MAE, which a path must beat to show it ranks turns
 * rather than shifting its level.
 *
 * Usage:
 *   npx tsx scripts/judge-hallucination-compare.ts <candidate.json> [--labels <earlier.json>]
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { G_EVAL_SCORE_RANGE, G_EVAL_VALID_SCORES, G_EVAL_MAX_SCORE } from '../../src/lib/judge/llm-judge-constants.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { runIfMain } from './cli-args.js';
import { DOCS_DIR } from './one-shot-eval.js';
import { turnKey } from './judge-turns.js';
import { CONFIGURATIONS, type Configuration, type HallucinationTurn } from './judge-hallucination-eval.js';

export const LABELS_FLAG = '--labels';
export const DEFAULT_LABELS_PATH = join(DOCS_DIR, 'archive', 'judge-hallucination-2026-09-25.json');
const LOG_PREFIX = '[hallucination-compare]';

export type CountOf = { hits: number; of: number };

export type ConfigurationComparison = {
  paired: number;
  mae: number | null;
  recall: CountOf;
  specificity: CountOf;
};

export type LabelComparison = {
  labelled: number;
  bestConstant: { grade: number; mae: number } | null;
  byConfiguration: Record<Configuration, ConfigurationComparison>;
};

/** A stored hallucination score is the normalized complement of the grade: 0 = grade 5, no fabrication. */
const isFlagged = (hallucination: number): boolean => hallucination > 0;

const toGradeSteps = (normalizedDiff: number): number => normalizedDiff * G_EVAL_SCORE_RANGE;

function meanAbsGradeSteps(pairs: ReadonlyArray<readonly [number, number]>): number | null {
  if (pairs.length === 0) return null;
  return toGradeSteps(pairs.reduce((acc, [label, score]) => acc + Math.abs(label - score), 0) / pairs.length);
}

function gradeAsHallucination(grade: number): number {
  return (G_EVAL_MAX_SCORE - grade) / G_EVAL_SCORE_RANGE;
}

export function compareToLabels(candidate: readonly HallucinationTurn[], labels: readonly HallucinationTurn[]): LabelComparison {
  const labelByKey = new Map<string, number>();
  for (const turn of labels) {
    const label = turn.reference[HALLUCINATION_EVAL_NAME];
    if (label !== undefined) labelByKey.set(turnKey(turn), label);
  }
  const labelValues = [...labelByKey.values()];
  const constantMaes = G_EVAL_VALID_SCORES.map(grade => ({
    grade,
    mae: meanAbsGradeSteps(labelValues.map(label => [label, gradeAsHallucination(grade)] as const)),
  }));
  const bestConstant = constantMaes.reduce<{ grade: number; mae: number } | null>(
    (best, c) => (c.mae !== null && (best === null || c.mae < best.mae) ? { grade: c.grade, mae: c.mae } : best),
    null,
  );

  const compare = (configuration: Configuration): ConfigurationComparison => {
    const pairs: Array<readonly [number, number]> = [];
    for (const turn of candidate) {
      const label = labelByKey.get(turnKey(turn));
      const score = turn[configuration][HALLUCINATION_EVAL_NAME];
      if (label !== undefined && score !== undefined) pairs.push([label, score]);
    }
    const flagged = pairs.filter(([label]) => isFlagged(label));
    const clean = pairs.filter(([label]) => !isFlagged(label));
    return {
      paired: pairs.length,
      mae: meanAbsGradeSteps(pairs),
      recall: { hits: flagged.filter(([, score]) => isFlagged(score)).length, of: flagged.length },
      specificity: { hits: clean.filter(([, score]) => !isFlagged(score)).length, of: clean.length },
    };
  };

  return {
    labelled: labelByKey.size,
    bestConstant,
    byConfiguration: Object.fromEntries(CONFIGURATIONS.map(c => [c, compare(c)])) as Record<Configuration, ConfigurationComparison>,
  };
}

async function readTurns(path: string): Promise<HallucinationTurn[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { turns?: unknown };
  if (!Array.isArray(parsed.turns)) throw new Error(`${path} has no turns — not a judge-hallucination results file`);
  return parsed.turns as HallucinationTurn[];
}

const MAE_DIGITS = 3;
const formatCount = ({ hits, of }: CountOf): string => `${hits}/${of}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const labelsAt = argv.indexOf(LABELS_FLAG);
  const labelsPath = labelsAt === -1 ? DEFAULT_LABELS_PATH : argv[labelsAt + 1];
  const candidatePath = argv.find((arg, i) => !arg.startsWith('--') && i !== labelsAt + 1);
  if (!candidatePath || !labelsPath) throw new Error(`usage: judge-hallucination-compare.ts <candidate.json> [${LABELS_FLAG} <earlier.json>]`);

  const result = compareToLabels(await readTurns(candidatePath), await readTurns(labelsPath));
  console.log(`${LOG_PREFIX} labels: ${labelsPath} (${result.labelled} turns)`);
  if (result.bestConstant) {
    console.log(`${LOG_PREFIX} best constant: always grade ${result.bestConstant.grade}, MAE ${result.bestConstant.mae.toFixed(MAE_DIGITS)}`);
  }
  for (const [configuration, c] of Object.entries(result.byConfiguration)) {
    console.log(`${LOG_PREFIX} ${configuration}: paired ${c.paired}, MAE ${c.mae?.toFixed(MAE_DIGITS) ?? 'n/a'}, `
      + `recall ${formatCount(c.recall)}, specificity ${formatCount(c.specificity)}`);
  }
}

runIfMain(import.meta.url, main, LOG_PREFIX);
