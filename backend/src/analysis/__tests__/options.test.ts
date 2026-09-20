import { describe, it, expect } from 'vitest';
import {
  blackScholes, impliedVolatility, normCdf, yearsToExpiry,
} from '../options/blackScholes.js';
import {
  calculatePcr, calculateMaxPain, deriveOiLevels, classifyBuildup,
  calculateIvPercentile, analyzeOiShift,
} from '../options/analytics.js';
import type { NormalizedOptionChain, OptionStrike } from '../../providers/types.js';

const leg = (over: Partial<OptionStrike['call']> = {}) => ({
  oi: 0, oiChange: 0, volume: 0, ltp: 0, iv: null,
  bid: null, ask: null, bidQty: null, askQty: null, prevClose: null,
  ...over,
});

function chain(strikes: OptionStrike[], spot = 100): NormalizedOptionChain {
  return {
    underlying: 'TEST',
    expiry: '2024-12-26',
    spot,
    futuresPrice: null,
    strikes,
    timestamp: new Date().toISOString(),
    lotSize: 50,
  };
}

describe('normCdf', () => {
  it('is 0.5 at zero', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
  });

  it('matches known quantiles', () => {
    expect(normCdf(1.96)).toBeCloseTo(0.975, 4);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 4);
    expect(normCdf(1)).toBeCloseTo(0.8413, 4);
  });

  it('is symmetric', () => {
    for (const x of [0.3, 1.1, 2.5]) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 6);
    }
  });
});

describe('blackScholes', () => {
  const base = { spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, volatility: 0.2 };

  it('prices a textbook ATM call', () => {
    // Standard reference: S=100, K=100, T=1, r=5%, sigma=20% → ~10.45
    const g = blackScholes({ ...base, type: 'CE' });
    expect(g.price).toBeCloseTo(10.4506, 3);
  });

  it('prices a textbook ATM put', () => {
    const g = blackScholes({ ...base, type: 'PE' });
    expect(g.price).toBeCloseTo(5.5735, 3);
  });

  it('satisfies put-call parity', () => {
    const c = blackScholes({ ...base, type: 'CE' }).price;
    const p = blackScholes({ ...base, type: 'PE' }).price;
    // C - P = S - K*e^(-rT)
    const parity = base.spot - base.strike * Math.exp(-base.rate * base.timeToExpiry);
    expect(c - p).toBeCloseTo(parity, 6);
  });

  it('keeps call delta in [0,1] and put delta in [-1,0]', () => {
    for (const strike of [70, 100, 130]) {
      const c = blackScholes({ ...base, strike, type: 'CE' });
      const p = blackScholes({ ...base, strike, type: 'PE' });
      expect(c.delta).toBeGreaterThanOrEqual(0);
      expect(c.delta).toBeLessThanOrEqual(1);
      expect(p.delta).toBeLessThanOrEqual(0);
      expect(p.delta).toBeGreaterThanOrEqual(-1);
      // delta_call - delta_put = 1 (no dividend)
      expect(c.delta - p.delta).toBeCloseTo(1, 6);
    }
  });

  it('gives calls and puts identical gamma and vega', () => {
    const c = blackScholes({ ...base, type: 'CE' });
    const p = blackScholes({ ...base, type: 'PE' });
    expect(c.gamma).toBeCloseTo(p.gamma, 10);
    expect(c.vega).toBeCloseTo(p.vega, 10);
  });

  it('returns intrinsic value at expiry', () => {
    const itm = blackScholes({ ...base, spot: 120, timeToExpiry: 0, type: 'CE' });
    expect(itm.price).toBe(20);
    expect(itm.delta).toBe(1);
    expect(itm.gamma).toBe(0);

    const otm = blackScholes({ ...base, spot: 80, timeToExpiry: 0, type: 'CE' });
    expect(otm.price).toBe(0);
    expect(otm.delta).toBe(0);
  });

  it('prices higher with more volatility', () => {
    const low = blackScholes({ ...base, volatility: 0.1, type: 'CE' }).price;
    const high = blackScholes({ ...base, volatility: 0.4, type: 'CE' }).price;
    expect(high).toBeGreaterThan(low);
  });

  it('reports theta as a negative per-day decay for a long option', () => {
    const g = blackScholes({ ...base, type: 'CE' });
    expect(g.theta).toBeLessThan(0);
    // A rough sanity bound: ATM 1-year option should not decay more than ~₹1/day.
    expect(Math.abs(g.theta)).toBeLessThan(1);
  });

  it('rejects a non-positive spot or strike', () => {
    expect(() => blackScholes({ ...base, spot: 0, type: 'CE' })).toThrow();
  });
});

describe('impliedVolatility', () => {
  it('recovers the volatility used to price an option', () => {
    for (const sigma of [0.1, 0.2, 0.35, 0.6]) {
      const price = blackScholes({
        spot: 100, strike: 100, timeToExpiry: 0.5, rate: 0.065, volatility: sigma, type: 'CE',
      }).price;

      const solved = impliedVolatility(price, {
        spot: 100, strike: 100, timeToExpiry: 0.5, rate: 0.065, type: 'CE',
      });
      expect(solved.converged).toBe(true);
      expect(solved.iv!).toBeCloseTo(sigma, 4);
    }
  });

  it('recovers volatility for OTM options too', () => {
    const price = blackScholes({
      spot: 100, strike: 120, timeToExpiry: 0.25, rate: 0.065, volatility: 0.3, type: 'CE',
    }).price;
    const solved = impliedVolatility(price, {
      spot: 100, strike: 120, timeToExpiry: 0.25, rate: 0.065, type: 'CE',
    });
    expect(solved.iv!).toBeCloseTo(0.3, 3);
  });

  it('returns null rather than a garbage number below intrinsic value', () => {
    // A deep ITM call priced below intrinsic is an arbitrage, not a volatility.
    const solved = impliedVolatility(1, {
      spot: 200, strike: 100, timeToExpiry: 1, rate: 0.05, type: 'CE',
    });
    expect(solved.iv).toBeNull();
    expect(solved.reason).toBe('below_intrinsic');
  });

  it('returns null for a non-positive price', () => {
    const solved = impliedVolatility(0, {
      spot: 100, strike: 100, timeToExpiry: 1, rate: 0.05, type: 'CE',
    });
    expect(solved.iv).toBeNull();
  });

  it('returns null for an expired option', () => {
    const solved = impliedVolatility(5, {
      spot: 100, strike: 100, timeToExpiry: 0, rate: 0.05, type: 'CE',
    });
    expect(solved.iv).toBeNull();
    expect(solved.reason).toBe('expired');
  });
});

describe('yearsToExpiry', () => {
  it('is zero for a past date', () => {
    expect(yearsToExpiry('2020-01-01')).toBe(0);
  });

  it('is roughly one year out for a date ~365 days ahead', () => {
    const future = new Date(Date.now() + 365 * 86400_000).toISOString().slice(0, 10);
    expect(yearsToExpiry(future)).toBeGreaterThan(0.99);
    expect(yearsToExpiry(future)).toBeLessThan(1.01);
  });
});

describe('calculatePcr', () => {
  it('divides total put OI by total call OI', () => {
    const c = chain([
      { strike: 100, call: leg({ oi: 1000 }), put: leg({ oi: 2000 }) },
      { strike: 110, call: leg({ oi: 1000 }), put: leg({ oi: 500 }) },
    ]);
    const pcr = calculatePcr(c);
    expect(pcr.totalCallOi).toBe(2000);
    expect(pcr.totalPutOi).toBe(2500);
    expect(pcr.pcrOi).toBeCloseTo(1.25, 10);
  });

  it('reports unavailable rather than zero when there is no OI', () => {
    const c = chain([{ strike: 100, call: null, put: null }]);
    const pcr = calculatePcr(c);
    expect(pcr.pcrOi).toBeNull();
    expect(pcr.band).toBe('unavailable');
    expect(pcr.note).toMatch(/not available/i);
  });

  it('bands the reading descriptively', () => {
    const low = calculatePcr(chain([{ strike: 100, call: leg({ oi: 1000 }), put: leg({ oi: 300 }) }]));
    expect(low.band).toBe('very_low');

    const neutral = calculatePcr(chain([{ strike: 100, call: leg({ oi: 1000 }), put: leg({ oi: 1000 }) }]));
    expect(neutral.band).toBe('neutral');

    const high = calculatePcr(chain([{ strike: 100, call: leg({ oi: 1000 }), put: leg({ oi: 2000 }) }]));
    expect(high.band).toBe('very_high');
  });
});

describe('calculateMaxPain', () => {
  it('finds the strike minimising total writer payout', () => {
    // All OI concentrated at 100 → max pain must be 100.
    const c = chain([
      { strike: 90, call: leg({ oi: 0 }), put: leg({ oi: 0 }) },
      { strike: 100, call: leg({ oi: 1000 }), put: leg({ oi: 1000 }) },
      { strike: 110, call: leg({ oi: 0 }), put: leg({ oi: 0 }) },
    ]);
    expect(calculateMaxPain(c).maxPain).toBe(100);
  });

  it('is pulled toward the heavier side', () => {
    const c = chain([
      { strike: 100, call: leg({ oi: 100 }), put: leg({ oi: 10000 }) },
      { strike: 110, call: leg({ oi: 100 }), put: leg({ oi: 100 }) },
      { strike: 120, call: leg({ oi: 10000 }), put: leg({ oi: 100 }) },
    ]);
    const mp = calculateMaxPain(c).maxPain!;
    // Heavy puts at 100 and heavy calls at 120 → pain minimised between them.
    expect(mp).toBeGreaterThanOrEqual(100);
    expect(mp).toBeLessThanOrEqual(120);
  });

  it('returns null with an empty chain rather than inventing a strike', () => {
    const result = calculateMaxPain(chain([]));
    expect(result.maxPain).toBeNull();
    expect(result.payoutByStrike).toEqual([]);
  });

  it('produces a payout curve covering every strike with OI', () => {
    const c = chain([
      { strike: 100, call: leg({ oi: 500 }), put: leg({ oi: 500 }) },
      { strike: 110, call: leg({ oi: 500 }), put: leg({ oi: 500 }) },
    ]);
    expect(calculateMaxPain(c).payoutByStrike).toHaveLength(2);
  });
});

describe('deriveOiLevels', () => {
  it('ranks strikes by open interest on each side', () => {
    const c = chain([
      { strike: 95, call: leg({ oi: 100 }), put: leg({ oi: 900 }) },
      { strike: 100, call: leg({ oi: 200 }), put: leg({ oi: 400 }) },
      { strike: 105, call: leg({ oi: 800 }), put: leg({ oi: 100 }) },
    ]);
    const levels = deriveOiLevels(c, 2);
    expect(levels.supports[0]!.strike).toBe(95);
    expect(levels.resistances[0]!.strike).toBe(105);
    expect(levels.supports[0]!.sharePct).toBeCloseTo((900 / 1400) * 100, 6);
  });
});

describe('classifyBuildup', () => {
  it('reads rising price with rising OI as long buildup', () => {
    const r = classifyBuildup(10, 5000, { priceBase: 100, oiBase: 50000 });
    expect(r.type).toBe('LONG_BUILDUP');
    expect(r.interpretation).toMatch(/conventionally read/i);
  });

  it('reads falling price with rising OI as short buildup', () => {
    expect(classifyBuildup(-10, 5000, { priceBase: 100, oiBase: 50000 }).type).toBe('SHORT_BUILDUP');
  });

  it('reads rising price with falling OI as short covering', () => {
    expect(classifyBuildup(10, -5000, { priceBase: 100, oiBase: 50000 }).type).toBe('SHORT_COVERING');
  });

  it('reads falling price with falling OI as long unwinding', () => {
    expect(classifyBuildup(-10, -5000, { priceBase: 100, oiBase: 50000 }).type).toBe('LONG_UNWINDING');
  });

  it('refuses to classify when either input is missing', () => {
    expect(classifyBuildup(null, 5000).type).toBe('INDETERMINATE');
    expect(classifyBuildup(10, null).type).toBe('INDETERMINATE');
  });

  it('refuses to classify noise inside the deadband', () => {
    const r = classifyBuildup(0.01, 5, { priceBase: 1000, oiBase: 100000 });
    expect(r.type).toBe('INDETERMINATE');
  });
});

describe('analyzeOiShift', () => {
  it('sums OI change per side and ranks the biggest moves', () => {
    const c = chain([
      { strike: 100, call: leg({ oi: 100, oiChange: 500 }), put: leg({ oi: 100, oiChange: -200 }) },
      { strike: 110, call: leg({ oi: 100, oiChange: 900 }), put: leg({ oi: 100, oiChange: 300 }) },
    ]);
    const shift = analyzeOiShift(c, 1);
    expect(shift.callOiChange).toBe(1400);
    expect(shift.putOiChange).toBe(100);
    expect(shift.topCallAdditions[0]!.strike).toBe(110);
    expect(shift.topPutUnwinds[0]!.strike).toBe(100);
  });
});

describe('calculateIvPercentile', () => {
  it('refuses to report on a small sample', () => {
    const r = calculateIvPercentile(20, [18, 19, 21]);
    expect(r.percentile).toBeNull();
    expect(r.note).toMatch(/at least 20/i);
  });

  it('computes a percentile on adequate history', () => {
    const history = Array.from({ length: 50 }, (_, i) => 10 + i * 0.5);
    const r = calculateIvPercentile(10, history);
    expect(r.percentile).toBeCloseTo(2, 0);

    const high = calculateIvPercentile(100, history);
    expect(high.percentile).toBe(100);
  });

  it('returns nulls when the current IV is unknown', () => {
    expect(calculateIvPercentile(null, Array(30).fill(20)).percentile).toBeNull();
  });
});
