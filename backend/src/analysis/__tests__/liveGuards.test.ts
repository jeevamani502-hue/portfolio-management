/**
 * The live-trading guards decide whether real orders are placed, and the
 * exit rules decide when real positions are closed. Every branch is pinned.
 */
import { describe, it, expect } from 'vitest';
import {
  liveBlockers, decideLiveExit,
  type LiveGuardConfig, type LiveGuardState, type LivePositionPlan,
} from '../options/liveGuards.js';
import { fromIst } from '../../utils/time.js';

const NOW = fromIst('2026-10-06', 11, 0); // Tuesday, inside the window

const cfg = (over: Partial<LiveGuardConfig> = {}): LiveGuardConfig => ({
  mode: 'CONFIRM',
  armedUntil: fromIst('2026-10-06', 15, 30),
  capital: 100_000,
  killSwitch: false,
  haltedReason: null,
  allowExpiryDay: false,
  windowStartMin: 9 * 60 + 30,
  windowEndMin: 15 * 60,
  maxOpenPositions: 1,
  maxTradesPerDay: 3,
  maxDailyLossPct: 2,
  minGrade: 'B',
  ...over,
});

const state = (over: Partial<LiveGuardState> = {}): LiveGuardState => ({
  openPositions: 0, tradesToday: 0, netPnlToday: 0, marketPhase: 'OPEN', now: NOW, daysToExpiry: 3, ...over,
});

const codes = (c: LiveGuardConfig, s: LiveGuardState) => liveBlockers(c, s).map((b) => b.code);

describe('liveBlockers', () => {
  it('is empty when armed, open, inside the window and within every cap', () => {
    expect(codes(cfg(), state())).toEqual([]);
  });

  it('blocks when off, killed, halted or not armed — each independently', () => {
    expect(codes(cfg({ mode: 'OFF' }), state())).toContain('mode_off');
    expect(codes(cfg({ killSwitch: true }), state())).toContain('kill_switch');
    expect(codes(cfg({ haltedReason: 'daily loss' }), state())).toContain('halted');
    expect(codes(cfg({ armedUntil: null }), state())).toContain('not_armed');
    expect(codes(cfg({ armedUntil: fromIst('2026-10-05', 15, 30) }), state())).toContain('not_armed');
  });

  it('requires capital', () => {
    expect(codes(cfg({ capital: null }), state())).toContain('no_capital');
  });

  it('blocks outside continuous trading and outside the entry window', () => {
    expect(codes(cfg(), state({ marketPhase: 'PRE_OPEN' }))).toContain('market_closed');
    expect(codes(cfg(), state({ now: fromIst('2026-10-06', 9, 20) }))).toContain('outside_window');
    expect(codes(cfg(), state({ now: fromIst('2026-10-06', 15, 10) }))).toContain('outside_window');
  });

  it('blocks expiry day unless allowed', () => {
    expect(codes(cfg(), state({ daysToExpiry: 0 }))).toContain('expiry_day');
    expect(codes(cfg({ allowExpiryDay: true }), state({ daysToExpiry: 0 }))).not.toContain('expiry_day');
  });

  it('halts at the daily loss cap and the position / trade counts', () => {
    expect(codes(cfg(), state({ netPnlToday: -2_000 }))).toContain('daily_loss');
    expect(codes(cfg(), state({ netPnlToday: -1_999 }))).not.toContain('daily_loss');
    expect(codes(cfg(), state({ openPositions: 1 }))).toContain('position_limit');
    expect(codes(cfg(), state({ tradesToday: 3 }))).toContain('daily_trade_limit');
  });
});

const plan = (over: Partial<LivePositionPlan> = {}): LivePositionPlan => ({
  action: 'BUY_CALL', expiry: '2026-10-09', product: 'INTRADAY',
  entryPremium: 100, stopPremium: 60, target1Premium: 160, target2Premium: 200,
  underlyingStop: 24_700, remainingQty: 130, lotSize: 65, t1Done: false, scaleOut: true,
  ...over,
});
const obs = (premium: number, spot: number | null = 25_000, now = NOW, squareOffMin = 15 * 60 + 15) =>
  ({ premium, spot, now, squareOffMin });

describe('decideLiveExit', () => {
  it('holds inside the plan', () => {
    expect(decideLiveExit(plan(), obs(110)).kind).toBe('HOLD');
  });

  it('exits everything on the stop and on invalidation, stop first', () => {
    const a = decideLiveExit(plan(), obs(59));
    expect(a.kind).toBe('EXIT_ALL');
    expect(a.kind === 'EXIT_ALL' && a.code).toBe('STOP');
    expect(a.kind === 'EXIT_ALL' && a.qty).toBe(130);
    const b = decideLiveExit(plan(), obs(90, 24_650));
    expect(b.kind === 'EXIT_ALL' && b.code).toBe('INVALIDATED');
    const put = decideLiveExit(plan({ action: 'BUY_PUT', underlyingStop: 25_300 }), obs(90, 25_350));
    expect(put.kind === 'EXIT_ALL' && put.code).toBe('INVALIDATED');
  });

  it('books half at target 1 with two or more lots, then runs the rest on a breakeven stop', () => {
    const a = decideLiveExit(plan(), obs(162));
    expect(a.kind).toBe('BOOK_HALF');
    expect(a.kind === 'BOOK_HALF' && a.qty).toBe(65);
    // After booking, the stop is the entry price.
    const b = decideLiveExit(plan({ t1Done: true, remainingQty: 65 }), obs(99));
    expect(b.kind === 'EXIT_ALL' && b.code).toBe('STOP');
    const c = decideLiveExit(plan({ t1Done: true, remainingQty: 65 }), obs(150));
    expect(c.kind).toBe('HOLD');
  });

  it('exits everything at target 1 with a single lot, or when scaling out is off', () => {
    expect(decideLiveExit(plan({ remainingQty: 65 }), obs(162)).kind).toBe('EXIT_ALL');
    expect(decideLiveExit(plan({ scaleOut: false }), obs(162)).kind).toBe('EXIT_ALL');
  });

  it('exits everything at target 2', () => {
    const a = decideLiveExit(plan({ t1Done: true, remainingQty: 65 }), obs(201));
    expect(a.kind === 'EXIT_ALL' && a.code).toBe('TARGET2');
  });

  it('squares off intraday positions at the configured time, and anything on expiry day', () => {
    const late = fromIst('2026-10-06', 15, 16);
    const a = decideLiveExit(plan(), obs(110, 25_000, late));
    expect(a.kind === 'EXIT_ALL' && a.code).toBe('SQUARE_OFF');
    const carry = decideLiveExit(plan({ product: 'CARRYFORWARD' }), obs(110, 25_000, late));
    expect(carry.kind).toBe('HOLD');
    const expiryDay = decideLiveExit(plan({ product: 'CARRYFORWARD', expiry: '2026-10-06' }), obs(110, 25_000, late));
    expect(expiryDay.kind === 'EXIT_ALL' && expiryDay.code).toBe('EXPIRY');
  });

  it('puts the stop ahead of a target in the same observation', () => {
    const a = decideLiveExit(plan({ target1Premium: 50 }), obs(55));
    expect(a.kind === 'EXIT_ALL' && a.code).toBe('STOP');
  });
});
