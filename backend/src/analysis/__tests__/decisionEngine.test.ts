/**
 * Tests for the F&O decision engine.
 *
 * The engine decides whether a graded option buy is issued at all, so the
 * cases that matter are the refusals and the grade boundaries: a gate must
 * kill the trade whatever the score, a missing input must lower coverage
 * rather than count for the trade, and the same inputs must always produce
 * the same checklist.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFnoDecision, calendarDaysToExpiry, meetsGrade,
  type FnoDecisionInput, type TimeframeView,
} from '../options/decisionEngine.js';
import type { NormalizedOptionChain, OptionStrike } from '../../providers/types.js';
import type { SignalReport, SetupMatch } from '../signals/engine.js';
import type { TechnicalSnapshot } from '../snapshot.js';
import type { RegimeResult } from '../regime.js';
import { fromIst } from '../../utils/time.js';

// ── fixtures ────────────────────────────────────────────────────────────────

/** A trading day well inside the session, in IST. */
const NOW = fromIst('2026-09-23', 11, 0); // Wednesday
const EXPIRY = '2026-09-30';

const leg = (over: Partial<{ ltp: number; bid: number; ask: number; oi: number; oiChange: number }> = {}) => ({
  oi: over.oi ?? 150_000,
  oiChange: over.oiChange ?? 0,
  volume: 8_000,
  ltp: over.ltp ?? 120,
  iv: 13,
  bid: over.bid ?? 119,
  ask: over.ask ?? 121,
  bidQty: 500,
  askQty: 500,
  prevClose: over.ltp ?? 120,
});

function chainAround(
  spot: number,
  opts: { putOiChange?: number; callOiChange?: number; putOi?: number; callOi?: number } = {},
): NormalizedOptionChain {
  const strikes: OptionStrike[] = [];
  for (let k = spot - 600; k <= spot + 600; k += 100) {
    strikes.push({
      strike: Math.round(k / 100) * 100,
      call: leg({ oi: opts.callOi ?? 150_000, oiChange: opts.callOiChange ?? 0 }),
      put: leg({ oi: opts.putOi ?? 200_000, oiChange: opts.putOiChange ?? 0 }),
    });
  }
  return {
    underlying: 'NIFTY', expiry: EXPIRY, spot, futuresPrice: null,
    strikes, timestamp: NOW.toISOString(), lotSize: 65,
  };
}

function snapshot(over: {
  timeframe?: string; close?: number; prevClose?: number; rsi?: number;
  trendLabel?: TechnicalSnapshot['trend']['assessment']['label'];
  vwap?: number | null; supertrendDirection?: 1 | -1 | null; atr?: number;
}): TechnicalSnapshot {
  const close = over.close ?? 25_000;
  return {
    symbol: 'NIFTY 50',
    timeframe: (over.timeframe ?? '1d') as TechnicalSnapshot['timeframe'],
    asOf: NOW.toISOString(),
    candleCount: 300,
    price: {
      close, open: close - 20, high: close + 40, low: close - 60,
      prevClose: over.prevClose ?? close - 100,
      change: 100, changePct: 0.4,
    },
    movingAverages: { sma20: close - 50, sma50: close - 200, sma100: close - 400, sma200: close - 800, ema9: close - 20, ema20: close - 60, ema50: close - 220 },
    momentum: {
      rsi14: over.rsi ?? 58, rsi14Prev: 55, macd: 12, macdSignal: 8, macdHistogram: 4,
      macdBullishCross: false, macdBearishCross: false, stochRsiK: 60, stochRsiD: 55,
    },
    volatility: {
      atr14: over.atr ?? 180, atrPct: 0.72, bbUpper: close + 300, bbMiddle: close - 50,
      bbLower: close - 400, bbWidth: 2.8, bbPercentB: 70, bbWidthPercentile: 50,
    },
    volume: { volume: 1, avgVolume20: 1, relativeVolume: 1.1, obv: 100, obvSlope5: 5, volumeConfirmsPrice: true },
    trend: {
      adx14: 24, plusDi: 28, minusDi: 16, supertrend: close - 300,
      supertrendDirection: over.supertrendDirection === undefined ? 1 : over.supertrendDirection,
      assessment: {
        label: over.trendLabel ?? 'UPTREND', strength: 60,
        reasons: ['Higher high on the most recent swing'],
        higherHighs: true, higherLows: true, lowerHighs: false, lowerLows: false,
        aboveSma50: true, aboveSma200: true, sma50AboveSma200: true,
      },
    },
    vwap: over.vwap === undefined ? null : over.vwap,
    priceVsVwapPct: null,
    pivots: { classic: null, fibonacci: null, camarilla: null },
    structure: {
      swings: [], supports: [], resistances: [], nearestSupport: null, nearestResistance: null,
      range20: null, range52w: null, divergence: null,
    },
    insufficient: [],
  };
}

const setupMatch = (kind: SetupMatch['kind'], direction: SetupMatch['direction'], strength = 65): SetupMatch => ({
  kind, direction, label: `${kind} test`, description: '', strength,
  requiredRules: [], confirmingRules: [], disqualifyingRules: [], reasons: [],
});

function report(overallScore: number | null, setups: SetupMatch[] = [], timeframe = '1d'): SignalReport {
  return {
    symbol: 'NIFTY 50', timeframe, asOf: NOW.toISOString(), allRules: [],
    scores: { trend: null, momentum: null, volume: null, volatility: null, structure: null },
    overallScore, setups, interpretation: '',
  };
}

const regime = (r: RegimeResult['regime']): RegimeResult => ({
  regime: r, compositeScore: 40, confidence: 80, components: [], summary: '', caveats: [],
  asOf: NOW.toISOString(),
});

/** Everything lined up for a bullish call buy. */
function bullishInput(over: Partial<FnoDecisionInput> = {}): FnoDecisionInput {
  const daily: TimeframeView = {
    snapshot: snapshot({ close: 25_000, prevClose: 24_900 }),
    report: report(72, [setupMatch('MOMENTUM', 'BULLISH')]),
  };
  const intraday: TimeframeView = {
    snapshot: snapshot({ timeframe: '15m', close: 25_010, vwap: 24_950, supertrendDirection: 1 }),
    report: report(64, [], '15m'),
  };
  return {
    underlying: 'NIFTY',
    chain: chainAround(25_000, { putOiChange: 300_000, callOiChange: 50_000 }),
    daily,
    intraday,
    regime: regime('UPTREND'),
    vix: 13.5,
    ivPercentile: 40,
    market: { phase: 'OPEN', minutesOfDay: 11 * 60 },
    capital: 1_500_000,
    riskPercent: 2,
    now: NOW,
    ...over,
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('buildFnoDecision', () => {
  it('grades a fully aligned bullish picture A and produces a complete plan', () => {
    const d = buildFnoDecision(bullishInput());
    expect(d.bias).toBe('BULLISH');
    expect(d.grade).toBe('A');
    expect(d.stance).toBe('ENTER');
    expect(d.action).toBe('BUY_CALL');
    expect(d.entryWindowOpen).toBe(true);
    expect(d.plan).not.toBeNull();
    expect(d.plan!.lots).toBeGreaterThan(0);
    expect(d.plan!.target2Premium).toBeGreaterThan(d.plan!.target1Premium);
    expect(d.plan!.underlyingStop).toBeLessThan(d.plan!.underlyingEntry);
    expect(d.plan!.underlyingTarget2).toBeGreaterThan(d.plan!.underlyingTarget1);
    expect(d.plan!.exitRules.length).toBeGreaterThanOrEqual(4);
    expect(d.plan!.exitRules[0]).toMatch(/^Stop:/);
    expect(d.gatesFailed).toEqual([]);
  });

  it('grades the mirror-image bearish picture and buys a put', () => {
    const d = buildFnoDecision(bullishInput({
      daily: {
        snapshot: snapshot({ close: 25_000, prevClose: 25_100, trendLabel: 'DOWNTREND', rsi: 42 }),
        report: report(28, [setupMatch('BREAKDOWN', 'BEARISH')]),
      },
      intraday: {
        snapshot: snapshot({ timeframe: '15m', close: 24_990, vwap: 25_050, supertrendDirection: -1 }),
        report: report(36, [], '15m'),
      },
      chain: chainAround(25_000, { putOiChange: 20_000, callOiChange: 400_000, putOi: 100_000, callOi: 200_000 }),
      regime: regime('DOWNTREND'),
    }));
    expect(d.bias).toBe('BEARISH');
    expect(d.action).toBe('BUY_PUT');
    expect(d.stance).toBe('ENTER');
    expect(d.plan!.underlyingStop).toBeGreaterThan(d.plan!.underlyingEntry);
  });

  describe('gates', () => {
    it('refuses when the daily score gives no direction, whatever else agrees', () => {
      const d = buildFnoDecision(bullishInput({
        daily: { snapshot: snapshot({}), report: report(52, [setupMatch('MOMENTUM', 'BULLISH')]) },
      }));
      expect(d.bias).toBe('NEUTRAL');
      expect(d.stance).toBe('AVOID');
      expect(d.action).toBe('NO_TRADE');
      expect(d.gatesFailed.join(' ')).toMatch(/do not agree/);
    });

    it('refuses fresh buys on expiry day and the day before', () => {
      const expiryDay = buildFnoDecision(bullishInput({
        chain: { ...chainAround(25_000, { putOiChange: 300_000 }), expiry: '2026-09-23' },
      }));
      expect(expiryDay.daysToExpiry).toBe(0);
      expect(expiryDay.stance).toBe('AVOID');
      expect(expiryDay.gatesFailed.join(' ')).toMatch(/Expiry day/);

      const dayBefore = buildFnoDecision(bullishInput({
        chain: { ...chainAround(25_000, { putOiChange: 300_000 }), expiry: '2026-09-24' },
      }));
      expect(dayBefore.daysToExpiry).toBe(1);
      expect(dayBefore.stance).toBe('AVOID');
    });

    it('refuses when the contract cannot be sized, and says why', () => {
      const d = buildFnoDecision(bullishInput({ capital: 20_000, riskPercent: 1 }));
      expect(d.stance).toBe('AVOID');
      expect(d.holdBecause.join(' ')).toMatch(/does not cover one lot/);
    });
  });

  describe('timing', () => {
    it('drops to grade B when the lower timeframe disagrees', () => {
      const d = buildFnoDecision(bullishInput({
        intraday: {
          snapshot: snapshot({ timeframe: '15m', close: 24_900, vwap: 24_950, supertrendDirection: -1 }),
          report: report(40, [], '15m'),
        },
      }));
      expect(d.grade).not.toBe('A');
      const f = d.factors.find((x) => x.id === 'intraday_agrees');
      expect(f?.verdict).toBe('fail');
      expect(d.factors.find((x) => x.id === 'vwap_side')?.verdict).toBe('fail');
    });

    it('closes the entry window in the first fifteen minutes and the last thirty', () => {
      const early = buildFnoDecision(bullishInput({ market: { phase: 'OPEN', minutesOfDay: 9 * 60 + 20 } }));
      expect(early.entryWindowOpen).toBe(false);
      expect(early.sessionNote).toMatch(/09:30/);

      const late = buildFnoDecision(bullishInput({ market: { phase: 'OPEN', minutesOfDay: 15 * 60 + 10 } }));
      expect(late.entryWindowOpen).toBe(false);
      expect(late.sessionNote).toMatch(/15:00/);
    });

    it('still builds the plan when the market is closed, but marks the window shut', () => {
      const d = buildFnoDecision(bullishInput({ market: { phase: 'CLOSED', minutesOfDay: 18 * 60 } }));
      expect(d.entryWindowOpen).toBe(false);
      expect(d.plan).not.toBeNull();
      expect(d.factors.find((x) => x.id === 'entry_window')?.verdict).toBe('na');
      expect(d.summary).toMatch(/Wait for the entry window/);
    });
  });

  describe('coverage and missing inputs', () => {
    it('does not count an unavailable input for the trade', () => {
      const full = buildFnoDecision(bullishInput());
      const sparse = buildFnoDecision(bullishInput({ intraday: null, regime: null, vix: null, ivPercentile: null }));
      expect(sparse.coverage).toBeLessThan(full.coverage);
      for (const id of ['intraday_agrees', 'vwap_side', 'regime_alignment', 'vix_level', 'iv_not_rich']) {
        expect(sparse.factors.find((f) => f.id === id)?.verdict).toBe('na');
      }
    });

    it('caps the grade at C when too little of the checklist is readable', () => {
      // Strip everything optional and blank the chain's OI so the chain group
      // cannot be read either.
      const chain = chainAround(25_000);
      for (const s of chain.strikes) {
        s.call = { ...s.call!, oi: null, oiChange: null };
        s.put = { ...s.put!, oi: null, oiChange: null };
      }
      const d = buildFnoDecision(bullishInput({
        chain, intraday: null, regime: null, vix: null, ivPercentile: null,
        market: { phase: 'CLOSED', minutesOfDay: 18 * 60 },
      }));
      expect(d.coverage).toBeLessThan(60);
      expect(['C', 'NONE']).toContain(d.grade);
      expect(d.stance).not.toBe('ENTER');
      if (d.grade === 'C') expect(d.holdBecause.join(' ')).toMatch(/could be evaluated/);
    });
  });

  describe('honesty', () => {
    it('never presents the grade as a probability', () => {
      const d = buildFnoDecision(bullishInput());
      expect(d.summary).toMatch(/not a probability/i);
      expect(d.summary).toMatch(/can be lost/i);
    });

    it('reports the checklist score as the setup confirmation so one number means one thing', () => {
      const d = buildFnoDecision(bullishInput());
      expect(d.setup.confirmation).toBe(d.score);
    });

    it('lists what would change the read', () => {
      const d = buildFnoDecision(bullishInput());
      expect(d.whatChangesMyMind.length).toBeGreaterThanOrEqual(3);
      expect(d.whatChangesMyMind.join(' ')).toMatch(/VWAP/);
    });

    it('is deterministic', () => {
      const a = buildFnoDecision(bullishInput());
      const b = buildFnoDecision(bullishInput());
      expect(a).toEqual(b);
    });
  });

  it('marks chasing when RSI is already stretched', () => {
    const d = buildFnoDecision(bullishInput({
      daily: { snapshot: snapshot({ rsi: 81 }), report: report(74, [setupMatch('MOMENTUM', 'BULLISH')]) },
    }));
    expect(d.factors.find((f) => f.id === 'not_exhausted')?.verdict).toBe('fail');
  });

  it('reads call-writer dominance against a bullish trade', () => {
    const d = buildFnoDecision(bullishInput({
      chain: chainAround(25_000, { putOiChange: 10_000, callOiChange: 500_000 }),
    }));
    expect(d.factors.find((f) => f.id === 'oi_flow')?.verdict).toBe('fail');
  });
});

describe('calendarDaysToExpiry', () => {
  it('counts IST calendar days and returns 0 on the expiry date', () => {
    expect(calendarDaysToExpiry('2026-09-23', NOW)).toBe(0);
    expect(calendarDaysToExpiry('2026-09-30', NOW)).toBe(7);
    // 23:30 IST is still the 23rd in IST even though it is the 24th nowhere.
    expect(calendarDaysToExpiry('2026-09-24', fromIst('2026-09-23', 23, 30))).toBe(1);
  });
});

describe('meetsGrade', () => {
  it('orders grades A > B > C > NONE', () => {
    expect(meetsGrade('A', 'B')).toBe(true);
    expect(meetsGrade('B', 'B')).toBe(true);
    expect(meetsGrade('C', 'B')).toBe(false);
    expect(meetsGrade('NONE', 'C')).toBe(false);
  });
});
