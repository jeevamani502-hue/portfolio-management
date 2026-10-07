/**
 * Live-trading guards and exit rules — the parts of the execution layer that
 * decide whether real money moves, kept pure so every rule has a test.
 *
 * Two pieces:
 *
 *   liveBlockers    everything that must be true before a new live order is
 *                   allowed. The list is ordered from "the user has not
 *                   turned it on" to "the day's loss cap is hit"; the first
 *                   entry is the one the UI leads with. Empty means go.
 *
 *   decideLiveExit  what to do with an open live position given the latest
 *                   premium and spot — the plan the decision engine issued,
 *                   applied mechanically. Capital preservation first: stop
 *                   and invalidation before anything else, then the clock,
 *                   then targets.
 *
 * None of this is advisory. A blocker stops the order; an exit action places
 * one.
 */
import { toIst } from '../../utils/time.js';
import { calendarDaysToExpiry } from './decisionEngine.js';
import type { Grade } from './decisionEngine.js';

export type LiveMode = 'OFF' | 'CONFIRM' | 'AUTO';

export interface LiveGuardConfig {
  mode: LiveMode;
  armedUntil: Date | null;
  capital: number | null;
  killSwitch: boolean;
  haltedReason: string | null;
  allowExpiryDay: boolean;
  /** IST minutes of day. */
  windowStartMin: number;
  windowEndMin: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  maxDailyLossPct: number;
  minGrade: Grade;
}

export interface LiveGuardState {
  openPositions: number;
  tradesToday: number;
  /** Realised net P&L today, rupees (negative is a loss). */
  netPnlToday: number;
  marketPhase: string;
  now: Date;
  /** Days to the expiry a new trade would use; null when not yet known. */
  daysToExpiry: number | null;
}

export interface LiveBlocker {
  code: string;
  detail: string;
  fix?: string;
}

const minutesLabel = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export function liveBlockers(cfg: LiveGuardConfig, s: LiveGuardState): LiveBlocker[] {
  const out: LiveBlocker[] = [];
  const ist = toIst(s.now);

  if (cfg.mode === 'OFF') {
    out.push({ code: 'mode_off', detail: 'Live trading is switched off.', fix: 'Choose Confirm or Auto mode, then arm for the day.' });
  }
  if (cfg.killSwitch) {
    out.push({ code: 'kill_switch', detail: 'The kill switch is engaged. No orders will be placed.', fix: 'Reset it deliberately from the Live Trading page.' });
  }
  if (cfg.haltedReason) {
    out.push({ code: 'halted', detail: `Halted: ${cfg.haltedReason}`, fix: 'Re-arm tomorrow, or reset after reviewing what happened.' });
  }
  if (!cfg.armedUntil || cfg.armedUntil.getTime() <= s.now.getTime()) {
    out.push({ code: 'not_armed', detail: 'Not armed. Arming lasts until the end of the session and must be repeated each day.', fix: 'Enter your capital and press Arm.' });
  }
  if (cfg.capital === null || !(cfg.capital > 0)) {
    out.push({ code: 'no_capital', detail: 'No capital stated, so nothing can be sized.', fix: 'Enter the amount when arming.' });
  }
  if (s.marketPhase !== 'OPEN') {
    out.push({ code: 'market_closed', detail: `The market is ${s.marketPhase.toLowerCase().replace(/_/g, ' ')}. Orders are placed only during continuous trading.` });
  } else if (ist.minutesOfDay < cfg.windowStartMin || ist.minutesOfDay > cfg.windowEndMin) {
    out.push({
      code: 'outside_window',
      detail: `Outside your entry window (${minutesLabel(cfg.windowStartMin)}–${minutesLabel(cfg.windowEndMin)} IST).`,
    });
  }
  if (!cfg.allowExpiryDay && s.daysToExpiry !== null && s.daysToExpiry <= 0) {
    out.push({ code: 'expiry_day', detail: 'Expiry day. Fresh option buys are disabled by your settings.' });
  }
  if (cfg.capital !== null && cfg.capital > 0) {
    const cap = cfg.capital * (cfg.maxDailyLossPct / 100);
    if (s.netPnlToday <= -cap) {
      out.push({
        code: 'daily_loss',
        detail: `Daily loss cap reached: ₹${Math.abs(s.netPnlToday).toFixed(0)} lost against a ₹${cap.toFixed(0)} cap (${cfg.maxDailyLossPct}% of capital).`,
        fix: 'No new positions today. The cap exists for exactly this moment.',
      });
    }
  }
  if (s.openPositions >= cfg.maxOpenPositions) {
    out.push({ code: 'position_limit', detail: `${s.openPositions} position(s) open, which is your limit of ${cfg.maxOpenPositions}.` });
  }
  if (s.tradesToday >= cfg.maxTradesPerDay) {
    out.push({ code: 'daily_trade_limit', detail: `${s.tradesToday} trade(s) today, which is your limit of ${cfg.maxTradesPerDay}.` });
  }
  return out;
}

// ── exits ───────────────────────────────────────────────────────────────────

export interface LivePositionPlan {
  action: 'BUY_CALL' | 'BUY_PUT';
  expiry: string;
  product: 'INTRADAY' | 'CARRYFORWARD';
  entryPremium: number;
  stopPremium: number;
  target1Premium: number;
  target2Premium: number;
  underlyingStop: number;
  remainingQty: number;
  lotSize: number;
  /** Half already booked at target 1; stop sits at entry. */
  t1Done: boolean;
  scaleOut: boolean;
}

export interface LiveExitObservation {
  premium: number;
  spot: number | null;
  now: Date;
  /** IST minutes of day after which intraday positions are flattened. */
  squareOffMin: number;
}

export type LiveExitCode = 'STOP' | 'INVALIDATED' | 'TARGET1' | 'TARGET2' | 'SQUARE_OFF' | 'EXPIRY';

export type LiveExitAction =
  | { kind: 'HOLD'; note: string }
  | { kind: 'EXIT_ALL'; code: LiveExitCode; qty: number; reason: string }
  | { kind: 'BOOK_HALF'; code: 'TARGET1'; qty: number; reason: string };

export function decideLiveExit(p: LivePositionPlan, o: LiveExitObservation): LiveExitAction {
  const { premium, spot, now } = o;
  const bull = p.action === 'BUY_CALL';
  const all = p.remainingQty;
  const stop = p.t1Done ? Math.max(p.stopPremium, p.entryPremium) : p.stopPremium;

  if (premium <= stop) {
    return {
      kind: 'EXIT_ALL', code: 'STOP', qty: all,
      reason: p.t1Done
        ? `Premium ₹${premium.toFixed(2)} fell back to the breakeven stop (₹${stop.toFixed(2)}) after target 1.`
        : `Premium ₹${premium.toFixed(2)} is at or below the ₹${stop.toFixed(2)} stop.`,
    };
  }
  if (spot !== null && (bull ? spot <= p.underlyingStop : spot >= p.underlyingStop)) {
    return {
      kind: 'EXIT_ALL', code: 'INVALIDATED', qty: all,
      reason: `The underlying traded through ${p.underlyingStop.toFixed(0)} (spot ${spot.toFixed(2)}); the thesis is invalid.`,
    };
  }

  const ist = toIst(now);
  const dte = calendarDaysToExpiry(p.expiry, now);
  if (dte <= 0 && ist.minutesOfDay >= o.squareOffMin) {
    return { kind: 'EXIT_ALL', code: 'EXPIRY', qty: all, reason: `Expiry day square-off at ${minutesLabel(o.squareOffMin)} IST.` };
  }
  if (p.product === 'INTRADAY' && ist.minutesOfDay >= o.squareOffMin) {
    return { kind: 'EXIT_ALL', code: 'SQUARE_OFF', qty: all, reason: `Intraday square-off at ${minutesLabel(o.squareOffMin)} IST, ahead of the broker's own.` };
  }

  if (premium >= p.target2Premium) {
    return { kind: 'EXIT_ALL', code: 'TARGET2', qty: all, reason: `Premium ₹${premium.toFixed(2)} reached target 2 (₹${p.target2Premium.toFixed(2)}).` };
  }
  if (!p.t1Done && premium >= p.target1Premium) {
    const lots = Math.floor(all / p.lotSize);
    if (p.scaleOut && lots >= 2) {
      const qty = Math.floor(lots / 2) * p.lotSize;
      return {
        kind: 'BOOK_HALF', code: 'TARGET1', qty,
        reason: `Premium ₹${premium.toFixed(2)} reached target 1 (₹${p.target1Premium.toFixed(2)}); booking ${qty / p.lotSize} of ${lots} lot(s) and moving the stop to entry.`,
      };
    }
    return { kind: 'EXIT_ALL', code: 'TARGET1', qty: all, reason: `Premium ₹${premium.toFixed(2)} reached target 1 (₹${p.target1Premium.toFixed(2)}).` };
  }

  return { kind: 'HOLD', note: `Premium ₹${premium.toFixed(2)}; stop ₹${stop.toFixed(2)}, next target ₹${(p.t1Done ? p.target2Premium : p.target1Premium).toFixed(2)}.` };
}
