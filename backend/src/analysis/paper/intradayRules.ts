/**
 * Intraday rules for the paper engine, pure so they can be tested.
 *
 * An intraday-only account never holds a position into the next session:
 * everything still open at the square-off time is closed at the market,
 * and anything found open from an earlier day (the worker was asleep, the
 * laptop was shut) is closed on the first sweep that sees it. No new
 * position is opened after the entry cutoff, because a trade that has
 * under an hour to work is mostly paying the spread and the costs.
 */
import { toIst } from '../../utils/time.js';

export interface IntradayConfig {
  intradayOnly: boolean;
  /** IST minutes of day after which no new position is opened. */
  entryCutoffMin: number;
  /** IST minutes of day at which every open position is closed. */
  squareOffMin: number;
}

export const minutesLabel = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Why a fresh entry is refused on intraday grounds, or null when it is allowed. */
export function intradayEntryBlock(cfg: IntradayConfig, now: Date): string | null {
  if (!cfg.intradayOnly) return null;
  const ist = toIst(now);
  if (ist.minutesOfDay >= cfg.entryCutoffMin) {
    return `past the intraday entry cutoff (${minutesLabel(cfg.entryCutoffMin)} IST) — no new positions this late in the day`;
  }
  return null;
}

export type SquareOffDecision =
  | { due: false }
  | { due: true; reason: string };

/** Whether an open position must be closed now, on intraday grounds alone. */
export function squareOffDue(cfg: IntradayConfig, entryAt: Date, now: Date): SquareOffDecision {
  if (!cfg.intradayOnly) return { due: false };
  const nowIst = toIst(now);
  const entryIst = toIst(entryAt);
  if (entryIst.dateKey < nowIst.dateKey) {
    return {
      due: true,
      reason: `opened on ${entryIst.dateKey} and still open on ${nowIst.dateKey}; an intraday account does not carry positions overnight, so it is closed at the first price seen today`,
    };
  }
  if (nowIst.minutesOfDay >= cfg.squareOffMin) {
    return { due: true, reason: `intraday square-off at ${minutesLabel(cfg.squareOffMin)} IST` };
  }
  return { due: false };
}
