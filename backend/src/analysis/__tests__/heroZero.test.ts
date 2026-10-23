import { describe, it, expect } from 'vitest';
import { buildHeroZeroDecision, pickHeroZeroContract, type HeroZeroConfig } from '../options/heroZero.js';
import type { TechnicalSnapshot } from '../snapshot.js';
import type { NormalizedOptionChain } from '../../providers/types.js';
import type { Candle } from '../indicators/index.js';

const cfg: HeroZeroConfig = {
  budget: 2000, minPremium: 3, maxPremium: 25, maxLots: 2,
  windowStartMin: 750, windowEndMin: 900, squareOffMin: 920,
  stopPct: 50, targetMultiple: 3, minAgree: 5,
};

const snap = (o: Partial<{
  close: number; open: number; vwap: number | null; ema9: number | null; ema20: number | null;
  st: 1 | -1 | null; rsi: number | null; rv: number | null;
}>): TechnicalSnapshot => ({
  symbol: 'NIFTY', timeframe: '5m', asOf: '2026-10-09T08:30:00.000Z', candleCount: 120,
  price: { close: o.close ?? 25100, open: o.open ?? 25080, high: 0, low: 0, prevClose: null, change: null, changePct: null },
  movingAverages: { sma20: null, sma50: null, sma100: null, sma200: null, ema9: o.ema9 ?? 25090, ema20: o.ema20 ?? 25060, ema50: null },
  momentum: { rsi14: o.rsi ?? 66, rsi14Prev: null, macd: null, macdSignal: null, macdHistogram: null, macdBullishCross: false, macdBearishCross: false, stochRsiK: null, stochRsiD: null },
  volatility: { atr14: null, atrPct: null, bbUpper: null, bbMiddle: null, bbLower: null, bbWidth: null, bbPercentB: null, bbWidthPercentile: null },
  volume: { volume: null, avgVolume20: null, relativeVolume: o.rv ?? 1.5, obv: null, obvSlope5: null, volumeConfirmsPrice: null },
  trend: { adx14: null, plusDi: null, minusDi: null, supertrend: 25000, supertrendDirection: o.st === undefined ? 1 : o.st, assessment: 'UPTREND' as never },
  vwap: o.vwap === undefined ? 25000 : o.vwap, priceVsVwapPct: null,
  pivots: { classic: null, fibonacci: null, camarilla: null },
  structure: { swings: [], supports: [], resistances: [], nearestSupport: null, nearestResistance: null, range20: null, range52w: null, divergence: null },
} as unknown as TechnicalSnapshot);

/** A rising day: nine quiet bars then three bars closing above the earlier high. */
const risingDay = (): Candle[] => {
  const out: Candle[] = [];
  for (let i = 0; i < 9; i++) out.push({ ts: `t${i}`, open: 25000, high: 25040, low: 24980, close: 25010, volume: 100 });
  out.push({ ts: 't9', open: 25010, high: 25060, low: 25005, close: 25055, volume: 150 });
  out.push({ ts: 't10', open: 25055, high: 25090, low: 25050, close: 25085, volume: 160 });
  out.push({ ts: 't11', open: 25085, high: 25110, low: 25080, close: 25100, volume: 170 });
  return out;
};

const leg = (ltp: number, extra: Partial<{ bid: number; ask: number; oi: number }> = {}) => ({
  oi: extra.oi ?? 50000, oiChange: null, volume: 1000, ltp, iv: null,
  bid: extra.bid ?? ltp - 0.05, ask: extra.ask ?? ltp + 0.05, bidQty: null, askQty: null, prevClose: null,
});

const chain = (spot = 25100): NormalizedOptionChain => ({
  underlying: 'NIFTY', expiry: '2026-10-09', spot, futuresPrice: null, timestamp: 'now', lotSize: 75,
  strikes: [
    { strike: 24900, call: leg(220), put: leg(4) },
    { strike: 25000, call: leg(130), put: leg(9) },
    { strike: 25100, call: leg(60), put: leg(40) },
    { strike: 25200, call: leg(18), put: leg(140) },
    { strike: 25300, call: leg(6), put: leg(230) },
    { strike: 25400, call: leg(2), put: leg(330) },
  ],
});

const base = (over: Partial<Parameters<typeof buildHeroZeroDecision>[0]> = {}) => buildHeroZeroDecision({
  underlying: 'NIFTY', expiry: '2026-10-09', daysToExpiry: 0, chain: chain(), intraday: snap({}),
  todayCandles: risingDay(), market: { phase: 'OPEN', minutesOfDay: 800 }, cfg, now: new Date('2026-10-09T07:50:00Z'),
  ...over,
});

describe('hero zero', () => {
  it('suggests a call on a rising expiry afternoon and sizes it from the budget', () => {
    const d = base();
    expect(d.side).toBe('BUY_CALL');
    expect(d.stance).toBe('ENTER');
    expect(d.agreeing).toBeGreaterThanOrEqual(5);
    expect(d.candidate).not.toBeNull();
    // Nearest OTM call inside ₹3–₹25 is 25200 at ₹18, limit at the ask 18.05 → one lot is ₹1353.75, so only 1 lot in ₹2000.
    expect(d.candidate!.strike).toBe(25200);
    expect(d.candidate!.optionType).toBe('CE');
    expect(d.candidate!.lots).toBe(1);
    expect(d.candidate!.outlay).toBeLessThanOrEqual(cfg.budget);
    expect(d.candidate!.stopPremium).toBeCloseTo(9.05, 1);
    expect(d.candidate!.target2Premium).toBeCloseTo(54.15, 1);
    expect(d.candidate!.target1Premium).toBeGreaterThan(d.candidate!.limit);
    expect(d.candidate!.target1Premium).toBeLessThan(d.candidate!.target2Premium);
    expect(d.warning).toMatch(/expire worthless/);
  });

  it('never enters when it is not expiry day', () => {
    const d = base({ daysToExpiry: 2 });
    expect(d.stance).toBe('AVOID');
    expect(d.gates.find((g) => g.code === 'expiry_day')!.ok).toBe(false);
  });

  it('never enters outside the afternoon window or when the market is closed', () => {
    expect(base({ market: { phase: 'OPEN', minutesOfDay: 600 } }).stance).toBe('AVOID');
    expect(base({ market: { phase: 'CLOSED', minutesOfDay: 800 } }).stance).toBe('AVOID');
  });

  it('waits when the conditions are split', () => {
    const d = base({ intraday: snap({ rsi: 50, rv: 0.8, vwap: 25100 }) });
    expect(d.stance).not.toBe('ENTER');
    expect(d.agreeing).toBeLessThan(cfg.minAgree);
  });

  it('chooses puts on a falling day', () => {
    const falling = risingDay().map((c) => ({ ...c, open: 50200 - c.open, high: 50200 - c.low, low: 50200 - c.high, close: 50200 - c.close }));
    const d = base({
      intraday: snap({ close: 25100, open: 25120, vwap: 25200, ema9: 25110, ema20: 25150, st: -1, rsi: 32 }),
      todayCandles: falling,
    });
    expect(d.side).toBe('BUY_PUT');
    expect(d.candidate?.optionType).toBe('PE');
    expect(d.candidate?.strike).toBe(25000);
  });

  it('refuses when one lot costs more than the budget', () => {
    const r = pickHeroZeroContract(chain(), 'BUY_CALL', { ...cfg, budget: 500 }, { underlyingStop: 25000 });
    expect(r.candidate).toBeNull();
    expect(r.note).toMatch(/budget/);
  });

  it('skips strikes with no open interest or a spread too wide to fill', () => {
    const c = chain();
    c.strikes[3]!.call = leg(18, { oi: 0 });
    c.strikes[4]!.call = leg(6, { bid: 4, ask: 8 });
    const r = pickHeroZeroContract(c, 'BUY_CALL', cfg, { underlyingStop: 25000 });
    expect(r.candidate).toBeNull();
  });

  it('caps the lots at the configured maximum', () => {
    const r = pickHeroZeroContract(chain(), 'BUY_CALL', { ...cfg, budget: 100000, maxLots: 2 }, { underlyingStop: 25000 });
    expect(r.candidate!.lots).toBe(2);
  });
});
