import { Link } from 'wouter';
import { scoreColorBand, SCORE_COLORS } from '../lib/quality-utils.js';
import { ColoredChip } from './ColoredChip.js';
import { MetaItem } from './MetaItem.js';
import { SectionBlock } from './SectionBlock.js';
import type { EvalRow } from './EvaluationTable.js';

export function StepScoreChip({ step, score, explanation }: {
  step: string | number;
  score: number;
  explanation?: string;
}) {
  const band = scoreColorBand(score, 'maximize');
  const color = SCORE_COLORS[band];
  return (
    <ColoredChip color={color} title={explanation ?? `Step ${step}: ${score.toFixed(2)}`}>
      {step}: {score.toFixed(2)}
    </ColoredChip>
  );
}

export function ToolVerificationChip({ toolName, toolCorrect, argsCorrect, score, index }: {
  toolName: string;
  toolCorrect: boolean;
  argsCorrect: boolean;
  score: number;
  index: number;
}) {
  const ok = toolCorrect && argsCorrect;
  const color = ok ? '#26d97f' : '#f04438';
  return (
    <ColoredChip
      color={color}
      title={`tool: ${toolCorrect ? 'correct' : 'wrong'}, args: ${argsCorrect ? 'correct' : 'wrong'}, score: ${score.toFixed(2)}`}
    >
      {toolName} {score.toFixed(2)}
    </ColoredChip>
  );
}

export function EvaluationExpandedRow({ row }: { row: EvalRow }) {
  const meta = [
    { label: 'Evaluator Type', value: row.evaluatorType },
    { label: 'Trace ID', value: row.traceId },
    { label: 'Span ID', value: row.spanId },
    { label: 'Session ID', value: row.sessionId },
    { label: 'Agent', value: row.agentName },
    { label: 'Trajectory Length', value: row.trajectoryLength },
  ].filter(m => m.value != null);

  const hasDetail = row.explanation || meta.length > 0 ||
    (row.stepScores && row.stepScores.length > 0) ||
    (row.toolVerifications && row.toolVerifications.length > 0);

  return (
    <div className="eval-expanded-content">
      {row.explanation && (
        <SectionBlock label="Explanation">
          <div className="text-xs" style={{ color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {row.explanation}
          </div>
        </SectionBlock>
      )}

      {meta.length > 0 && (
        <div className="mb-3 flex-wrap gap-4">
          {meta.map(m => <MetaItem key={m.label} label={m.label} value={m.value} />)}
        </div>
      )}

      {row.stepScores && row.stepScores.length > 0 && (
        <SectionBlock label="Step Scores">
          <div className="flex-wrap gap-1-5">
            {row.stepScores.map(s => (
              <StepScoreChip key={`${s.step}`} step={s.step} score={s.score} explanation={s.explanation} />
            ))}
          </div>
        </SectionBlock>
      )}

      {row.toolVerifications && row.toolVerifications.length > 0 && (
        <SectionBlock label="Tool Verifications">
          <div className="flex-wrap gap-1-5">
            {row.toolVerifications.map((tv, i) => (
              <ToolVerificationChip
                key={`${tv.toolName}-${i}`}
                toolName={tv.toolName}
                toolCorrect={tv.toolCorrect}
                argsCorrect={tv.argsCorrect}
                score={tv.score}
                index={i}
              />
            ))}
          </div>
        </SectionBlock>
      )}

      {/* back-link (not ArrowLink) — different class with margin-bottom reset via mb-0 */}
      {(row.traceId || row.sessionId) && (
        <div className="gap-4" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex' }}>
          {row.traceId && (
            <Link href={`/evaluations/trace/${row.traceId}`} className="back-link mb-0">
              View full evaluation detail &rarr;
            </Link>
          )}
          {row.sessionId ? (
            <Link href={`/sessions/${row.sessionId}`} className="back-link mb-0">
              View trace spans &rarr;
            </Link>
          ) : row.traceId ? (
            <Link href={`/traces/${row.traceId}`} className="back-link mb-0">
              View trace spans &rarr;
            </Link>
          ) : null}
        </div>
      )}

      {!hasDetail && !row.traceId && !row.sessionId && (
        <div className="text-muted text-xs">
          No additional detail available.
        </div>
      )}
    </div>
  );
}
