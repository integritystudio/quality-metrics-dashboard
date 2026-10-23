#!/usr/bin/env tsx
/**
 * Probes Haiku on hallucination alone, outside the consolidated call, on the tool
 * turns of an earlier judge-hallucination-eval.ts run (HALLUCINATION-METHOD-RESEARCH).
 *
 * - `isolated`: HALLUCINATION_CRITERIA through scoreCriterion, the path the eval's
 *   reference uses, so only the model differs from the reference.
 * - `claims`: two calls per turn. One lists the claims the output presents as
 *   observed; one labels each against the tool output as supported, contradicted
 *   or absent. A turn is flagged when any claim is contradicted or absent, and its
 *   stored score is that share of its claims.
 *
 * Scores are compared with the labels file by recall and specificity. MAE is printed
 * for `isolated` only: a `claims` score is a share of claims, not a grade.
 *
 * Usage:
 *   doppler run -p integrity-studio -c prd -- npx tsx scripts/judge-hallucination-probe.ts --method isolated|claims [--labels <run.json>]
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { HALLUCINATION_CRITERIA } from '../../src/lib/judge/llm-judge-config.js';
import { sanitizeContextArray, sanitizeForPrompt, safeJSONParse } from '../../src/lib/judge/llm-as-judge.js';
import { HALLUCINATION_EVAL_NAME } from '../../src/lib/validation/dashboard-schemas.js';
import { CliArgError, exitOnCliArgError, parseCli, runIfMain } from './cli-args.js';
import { createConsolidatedProvider, scoreCriterion, type ConsolidatedProvider, type JsonSchemaObject } from './judge-consolidated.js';
import { resolveJudgeApiKey } from './judge-credentials.js';
import { fitContextForJudge, turnKey, type Turn } from './judge-turns.js';
import { FROZEN_TURNS_PATH } from './judge-quality-eval.js';
import { addCallUsage, createCallUsageTotals, judgePricing, tokenUsageCostUsd } from './judge-usage.js';
import { processBatch } from './judge-evaluations.js';
import { DOCS_DIR, NO_BATCH_DELAY_MS } from './one-shot-eval.js';
import { compareScores, hallucinationLabels, DEFAULT_LABELS_PATH, type ConfigurationComparison } from './judge-hallucination-compare.js';
import type { HallucinationTurn } from './judge-hallucination-eval.js';

export const METHOD_FLAG = '--method';
export const LABELS_FLAG = '--labels';
export const PROBE_METHODS = ['isolated', 'claims'] as const;
export type ProbeMethod = typeof PROBE_METHODS[number];

export const CLAIM_LABELS = ['supported', 'contradicted', 'absent'] as const;
export type ClaimLabel = typeof CLAIM_LABELS[number];
const FABRICATED_LABELS: ReadonlySet<ClaimLabel> = new Set(['contradicted', 'absent']);

const RESULTS_DIR = join(DOCS_DIR, 'hallucination-probes');
const PROBE_CONCURRENCY = 4;
const JSON_INDENT = 2;
const MAE_DIGITS = 3;
const USD_DIGITS = 4;
const LOG_PREFIX = '[hallucination-probe]';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type ProbeArgs = { method: ProbeMethod; labelsPath: string };

const isProbeMethod = (value: string): value is ProbeMethod => (PROBE_METHODS as readonly string[]).includes(value);

export function parseProbeArgs(argv: readonly string[]): ProbeArgs {
  const cli = parseCli(argv, { values: [METHOD_FLAG, LABELS_FLAG] }, { allowUnknown: false });
  const method = cli.value(METHOD_FLAG);
  if (method === undefined || !isProbeMethod(method)) {
    throw new CliArgError(`${METHOD_FLAG} must be one of ${PROBE_METHODS.join(', ')}`);
  }
  return { method, labelsPath: cli.value(LABELS_FLAG) ?? DEFAULT_LABELS_PATH };
}

// ---------------------------------------------------------------------------
// Claims method
// ---------------------------------------------------------------------------

const claimsSchema = z.object({ claims: z.array(z.object({ claim: z.string() })) });
const verdictsSchema = z.object({
  verdicts: z.array(z.object({ claim: z.string(), label: z.enum(CLAIM_LABELS), evidence: z.string() })),
});
export type ClaimVerdict = z.infer<typeof verdictsSchema>['verdicts'][number];

const stringField = { type: 'string' } as const;

const CLAIMS_JSON_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: { type: 'object', properties: { claim: stringField }, required: ['claim'], additionalProperties: false },
    },
  },
  required: ['claims'],
  additionalProperties: false,
};

const VERDICTS_JSON_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: stringField, label: { type: 'string', enum: [...CLAIM_LABELS] }, evidence: stringField },
        required: ['claim', 'label', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdicts'],
  additionalProperties: false,
};

export function buildClaimsPrompt(output: string): string {
  return [
    'List every claim in the Output below that it presents as observed: a file name, value, command result, error message, tool output, or an action it says it completed.',
    'Quote or closely paraphrase each claim, one per entry. Skip plans, opinions, questions and general knowledge. Return an empty list when there are none.',
    `\nOutput: ${sanitizeForPrompt(output)}`,
  ].join('\n');
}

export function buildVerdictsPrompt(claims: readonly string[], toolContext: readonly string[]): string {
  return [
    'Label each claim against the Context, which is the tool output the claims should be based on.',
    '- supported: the Context contains it.',
    '- contradicted: the Context says otherwise.',
    '- absent: the claim says it was observed, but the Context does not contain it.',
    'For evidence, quote the Context passage you used, or write "none". Return one verdict per claim, in order.',
    `\nContext: ${sanitizeContextArray([...toolContext]).join('\n')}`,
    `\nClaims:\n${claims.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
  ].join('\n');
}

/** Share of claims that are contradicted or absent; 0 when there are no claims. */
export function fabricatedShare(verdicts: readonly ClaimVerdict[]): number {
  if (verdicts.length === 0) return 0;
  return verdicts.filter(v => FABRICATED_LABELS.has(v.label)).length / verdicts.length;
}

async function scoreClaims(provider: ConsolidatedProvider, turn: Turn): Promise<{ score: number; verdicts: ClaimVerdict[] }> {
  const extracted = await provider.generate(buildClaimsPrompt(turn.assistantText), { schema: CLAIMS_JSON_SCHEMA });
  const claims = claimsSchema.parse(safeJSONParse(extracted.text)).claims.map(c => c.claim);
  if (claims.length === 0) return { score: 0, verdicts: [] };
  const judged = await provider.generate(buildVerdictsPrompt(claims, fitContextForJudge(turn.toolResults)), { schema: VERDICTS_JSON_SCHEMA });
  const { verdicts } = verdictsSchema.parse(safeJSONParse(judged.text));
  return { score: fabricatedShare(verdicts), verdicts };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readLabelledTurns(path: string): Promise<HallucinationTurn[]> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as { turns?: unknown };
  if (!Array.isArray(parsed.turns)) throw new Error(`${path} has no turns — not a judge-hallucination results file`);
  return parsed.turns as HallucinationTurn[];
}

function formatComparison(c: ConfigurationComparison, withMae: boolean): string {
  const mae = withMae ? `MAE ${c.mae?.toFixed(MAE_DIGITS) ?? 'n/a'}, ` : '';
  return `paired ${c.paired}, ${mae}recall ${c.recall.hits}/${c.recall.of}, specificity ${c.specificity.hits}/${c.specificity.of}`;
}

async function main(): Promise<void> {
  const { method, labelsPath } = exitOnCliArgError(LOG_PREFIX, () => parseProbeArgs(process.argv.slice(2)));
  const credential = resolveJudgeApiKey();
  if (!credential) throw new Error('no judge API key');
  console.log(`${LOG_PREFIX} ${method}, key from ${credential.source}, labels ${labelsPath}`);

  const labelled = await readLabelledTurns(labelsPath);
  const frozen = new Map((JSON.parse(await readFile(FROZEN_TURNS_PATH, 'utf8')) as Turn[]).map(t => [turnKey(t), t]));
  const turns = labelled.filter(t => t.hasTools && frozen.has(turnKey(t))).map(t => frozen.get(turnKey(t)) as Turn);
  console.log(`${LOG_PREFIX} ${turns.length} tool turns`);

  const totals = createCallUsageTotals();
  const provider = await createConsolidatedProvider({ apiKey: credential.apiKey, onUsage: u => addCallUsage(totals, u) });
  const stepsCache = new Map<string, Promise<string>>();
  const scores = new Map<string, number>();
  const details: Record<string, unknown> = {};
  const failures: string[] = [];

  await processBatch(turns, PROBE_CONCURRENCY, NO_BATCH_DELAY_MS, async (turn) => {
    const key = turnKey(turn);
    try {
      if (method === 'isolated') {
        scores.set(key, 1 - await scoreCriterion(provider, turn, HALLUCINATION_CRITERIA, stepsCache));
      } else {
        const { score, verdicts } = await scoreClaims(provider, turn);
        scores.set(key, score);
        details[key] = verdicts;
      }
    } catch (err) {
      failures.push(`${key}: ${String(err)}`);
    }
  });

  const comparison = compareScores(scores, hallucinationLabels(labelled));
  const usd = tokenUsageCostUsd(totals, judgePricing());
  await mkdir(RESULTS_DIR, { recursive: true });
  const outPath = join(RESULTS_DIR, `${method}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(outPath, `${JSON.stringify({
    method, labelsPath, usd, comparison, failures,
    scores: Object.fromEntries(scores), details, criterion: HALLUCINATION_EVAL_NAME,
  }, null, JSON_INDENT)}\n`);

  console.log(`${LOG_PREFIX} ${formatComparison(comparison, method === 'isolated')}`);
  console.log(`${LOG_PREFIX} failures ${failures.length}, spent $${usd.toFixed(USD_DIGITS)}; results: ${outPath}`);
}

runIfMain(import.meta.url, main, LOG_PREFIX);
