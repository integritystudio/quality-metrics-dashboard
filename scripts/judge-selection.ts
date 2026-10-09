/**
 * Which discovered turns a judge run scores (cloud-read migration Phase 4).
 *
 * Every skip is decided before `--limit`, never after. The limit used to slice
 * the discovered turns first and leave dedup to the per-criterion checks
 * inside the evaluators, so a run took the same first N turns in discovery
 * order whether or not they were already judged. With the dedup set empty
 * (the schema gate fixed alongside this), the scheduled run re-judged the same
 * ~100 turns twice a day from 2026-09-22.
 *
 * A turn is skipped when:
 * - **judged**: `selectCriteria` finds no criterion left to score. It mirrors
 *   `evaluateTurn`'s dedup keys and gating, so this is the exact test for both
 *   scoring modes.
 * - **withheld**: its account is stamped `null` (unmapped, TKR3). Its records
 *   would never be sent, so scoring it only spends.
 * - **held for a key**: its records would route to a secret missing from the
 *   environment — an account key, or `INJECT_HMAC_SECRET` for an unstamped
 *   turn, which takes the webhook. A run that has the secret judges it.
 *
 * The last two apply only when the run posts (`deliverableOnly`); `--seed`
 * writes its file and posts nothing.
 */

import { asString } from './account-stamps.js';
import { selectCriteria } from './judge-consolidated.js';
import type { Turn } from './judge-turns.js';
import { increment } from './collections.js';

/** Signs the webhook, which is where an unstamped turn's records go. */
export const WEBHOOK_SECRET_ENV = 'INJECT_HMAC_SECRET';

export type TurnSkip = 'judged' | 'withheld' | 'held-for-key';

export interface SelectOptions {
  /** Most turns to select; applied after every skip. */
  limit: number;
  /** Skip turns whose records could not be delivered this run. */
  deliverableOnly: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface TurnSelection {
  selected: Turn[];
  discovered: number;
  judged: number;
  withheld: number;
  /** Turns held, by the secret their records need. */
  heldForKey: Record<string, number>;
  /** Turns left to judge before the limit; `selected` is at most `limit` of them. */
  pending: number;
}

/** The secret a turn's records are sent with: its account's key, or the webhook's. */
function deliverySecret(turn: Turn): string | null {
  if (turn.identityKeyRef === null) return null;
  return turn.identityKeyRef ?? WEBHOOK_SECRET_ENV;
}

/** Why `turn` is not judged this run, or `undefined` when it is. */
export function turnSkip(
  turn: Turn,
  existingKeys: Set<string>,
  opts: Pick<SelectOptions, 'deliverableOnly' | 'env'>,
): TurnSkip | undefined {
  if (selectCriteria(turn, existingKeys).recordNames.length === 0) return 'judged';
  if (!opts.deliverableOnly) return undefined;
  const secret = deliverySecret(turn);
  if (secret === null) return 'withheld';
  return asString((opts.env ?? process.env)[secret]) ? undefined : 'held-for-key';
}

/** Oldest first, session id breaking ties: the same order whichever source found the turns. */
function byTurnTime(a: Turn, b: Turn): number {
  return Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sessionId.localeCompare(b.sessionId);
}

/**
 * Drop the turns this run must not judge, then take the `limit` oldest. The
 * order is fixed rather than discovery order so the local and cloud sources,
 * which list sessions differently, select the same turns; a date scope is
 * what points a run at recent turns instead of the backlog.
 */
export function selectTurns(turns: readonly Turn[], existingKeys: Set<string>, opts: SelectOptions): TurnSelection {
  const selection: TurnSelection = {
    selected: [],
    discovered: turns.length,
    judged: 0,
    withheld: 0,
    heldForKey: {},
    pending: 0,
  };
  for (const turn of turns) {
    const skip = turnSkip(turn, existingKeys, opts);
    if (skip === 'judged') {
      selection.judged++;
    } else if (skip === 'withheld') {
      selection.withheld++;
    } else if (skip === 'held-for-key') {
      const secret = deliverySecret(turn)!;
      increment(selection.heldForKey, secret);
    } else {
      selection.selected.push(turn);
    }
  }
  selection.pending = selection.selected.length;
  selection.selected = selection.selected.sort(byTurnTime).slice(0, opts.limit);
  return selection;
}

/** One log line in the pipeline's `k=v` shape. */
export function formatTurnSelection(s: TurnSelection): string {
  const held = Object.entries(s.heldForKey).map(([k, v]) => `${k}=${v}`).join(' ');
  return `discovered=${s.discovered} judged=${s.judged} withheld=${s.withheld}`
    + (held ? ` heldForKey[${held}]` : '')
    + ` pending=${s.pending} selected=${s.selected.length}`;
}
