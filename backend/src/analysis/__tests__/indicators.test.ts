import { describe, it, expect } from 'vitest';
import {
  sma, ema, rsi, macd, atr, trueRange, bollingerBands, adx, supertrend,
  vwap, obv, relativeVolume, classicPivots, crossedAbove, crossedBelow,
  last, at, percentileRank, type Candle,
} from '../indicators/index.js';

/** Build candles from close prices, with a synthetic but consistent range. */
function candlesFrom(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((c, i) => ({
    ts: new Date(Date.UTC(2024, 0, 1 + i, 4, 0)).toISOString(),
    open: i === 0 ? c : closes[i - 1]!,
    high: c * 1.01,
    low: c * 0.99,
    close: c,
    volume: volumes?.[i] ?? 1000,
    oi: null,
  }));
}

describe('sma', () => {
  it('returns null until the window is full, then the mean', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });

  it('returns all nulls when the series is shorter than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('matches a hand-computed 5-period average', () => {
    const out = sma([10, 20, 30, 40, 50, 60], 5);
    expect(out[4]).toBe(30); // (10+20+30+40+50)/5
    expect(out[5]).toBe(40); // (20+30+40+50+60)/5
  });
});

describe('ema', () => {
  it('seeds on the SMA of the first `period` values', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    // Seed = (1+2+3)/3 = 2 at index 2
    expect(out[2]).toBe(2);
    // k = 2/(3+1) = 0.5; next = 4*0.5 + 2*0.5 = 3
    expect(out[3]).toBe(3);
    // next = 5*0.5 + 3*0.5 = 4
    expect(out[4]).toBe(4);
  });

  it('reacts faster than SMA to a step change', () => {
    const series = [...Array(20).fill(100), ...Array(5).fill(120)];
    const e = last(ema(series, 10))!;
    const s = last(sma(series, 10))!;
    expect(e).toBeGreaterThan(s);
  });
});

describe('rsi', () => {
  it('returns 100 when every change is a gain', () => {
    const rising = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(last(rsi(rising, 14))).toBe(100);
  });

  it('approaches 0 when every change is a loss', () => {
    const falling = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(last(rsi(falling, 14))).toBeCloseTo(0, 5);
  });

  it('sits near 50 for an alternating series', () => {
    const flat = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const v = last(rsi(flat, 14))!;
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(60);
  });

  it('stays within 0 and 100 on random-ish data', () => {
    const series = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 10 + i * 0.1);
    for (const v of rsi(series, 14)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('is null before enough history exists', () => {
    const out = rsi([1, 2, 3], 14);
    expect(out.every((v) => v === null)).toBe(true);
  });
});

describe('macd', () => {
  it('produces a positive line when the fast EMA leads', () => {
    const rising = Array.from({ length: 80 }, (_, i) => 100 + i);
    const m = macd(rising);
    expect(last(m.macd)!).toBeGreaterThan(0);
  });

  it('keeps histogram equal to macd minus signal', () => {
    const series = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 8);
    const m = macd(series);
    for (let i = 0; i < series.length; i += 1) {
      const line = m.macd[i];
      const sig = m.signal[i];
      const hist = m.histogram[i];
      if (line === null || line === undefined || sig === null || sig === undefined) {
        expect(hist ?? null).toBeNull();
        continue;
      }
      expect(hist!).toBeCloseTo(line - sig, 10);
    }
  });
});

describe('trueRange / atr', () => {
  it('uses high-low for the first bar', () => {
    const c = candlesFrom([100, 101]);
    expect(trueRange(c)[0]).toBeCloseTo(c[0]!.high - c[0]!.low, 10);
  });

  it('accounts for a gap through the previous close', () => {
    const candles: Candle[] = [
      { ts: 'a', open: 100, high: 101, low: 99, close: 100, volume: 1 },
      // Gaps up: the true range must span from the previous close.
      { ts: 'b', open: 110, high: 112, low: 109, close: 111, volume: 1 },
    ];
    // max(112-109, |112-100|, |109-100|) = 12
    expect(trueRange(candles)[1]).toBe(12);
  });

  it('is always positive for a real series', () => {
    const c = candlesFrom(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 5));
    const a = last(atr(c, 14));
    expect(a).not.toBeNull();
    expect(a!).toBeGreaterThan(0);
  });
});

describe('bollingerBands', () => {
  it('collapses to the mean when prices are constant', () => {
    const flat = Array(40).fill(100);
    const bb = bollingerBands(flat, 20, 2);
    expect(last(bb.upper)).toBeCloseTo(100, 10);
    expect(last(bb.lower)).toBeCloseTo(100, 10);
    expect(last(bb.bandwidth)).toBeCloseTo(0, 10);
  });

  it('places bands symmetrically around the middle', () => {
    const series = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5);
    const bb = bollingerBands(series, 20, 2);
    const u = last(bb.upper)!;
    const m = last(bb.middle)!;
    const l = last(bb.lower)!;
    expect(u - m).toBeCloseTo(m - l, 8);
  });

  it('reports %B above 100 when price exceeds the upper band', () => {
    const series = [...Array(25).fill(100), 130];
    const bb = bollingerBands(series, 20, 2);
    expect(last(bb.percentB)!).toBeGreaterThan(100);
  });
});

describe('adx', () => {
  it('reads high on a clean one-directional trend', () => {
    const c = candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
    const a = adx(c, 14);
    expect(last(a.adx)!).toBeGreaterThan(25);
    expect(last(a.plusDi)!).toBeGreaterThan(last(a.minusDi)!);
  });

  it('reads low on a choppy series', () => {
    const c = candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + (i % 2 === 0 ? 0 : 1)));
    const value = last(adx(c, 14).adx);
    if (value !== null) expect(value).toBeLessThan(40);
  });

  it('returns nulls when history is too short', () => {
    const c = candlesFrom([100, 101, 102]);
    expect(adx(c, 14).adx.every((v) => v === null)).toBe(true);
  });
});

describe('supertrend', () => {
  it('turns bullish in a sustained uptrend', () => {
    const c = candlesFrom(Array.from({ length: 60 }, (_, i) => 100 + i));
    expect(last(supertrend(c, 10, 3).direction)).toBe(1);
  });

  it('turns bearish in a sustained downtrend', () => {
    const c = candlesFrom(Array.from({ length: 60 }, (_, i) => 200 - i));
    expect(last(supertrend(c, 10, 3).direction)).toBe(-1);
  });

  it('keeps the line below price when bullish', () => {
    const c = candlesFrom(Array.from({ length: 60 }, (_, i) => 100 + i));
    const st = supertrend(c, 10, 3);
    expect(last(st.value)!).toBeLessThan(c.at(-1)!.close);
  });
});

describe('vwap', () => {
  it('resets at each session boundary', () => {
    const day1 = candlesFrom([100, 100, 100]).map((c) => ({ ...c, volume: 100 }));
    const day2 = candlesFrom([200, 200, 200]).map((c) => ({ ...c, volume: 100 }));
    const all = [
      ...day1.map((c) => ({ ...c, ts: '2024-01-01T04:00:00.000Z' })),
      ...day2.map((c) => ({ ...c, ts: '2024-01-02T04:00:00.000Z' })),
    ];
    const v = vwap(all, (c) => c.ts.slice(0, 10));
    // Day 2 VWAP must reflect only day-2 prices, not blend with day 1.
    expect(last(v)!).toBeCloseTo(200, 0);
  });

  it('equals typical price when volume is uniform and price constant', () => {
    const c = candlesFrom([100, 100, 100]);
    const v = vwap(c, () => 'one-session');
    const typical = (c[0]!.high + c[0]!.low + c[0]!.close) / 3;
    expect(last(v)!).toBeCloseTo(typical, 8);
  });
});

describe('obv and relativeVolume', () => {
  it('accumulates OBV upward when price rises', () => {
    const c = candlesFrom([100, 101, 102, 103], [10, 20, 30, 40]);
    const o = obv(c);
    expect(o.at(-1)).toBe(20 + 30 + 40);
  });

  it('subtracts volume when price falls', () => {
    const c = candlesFrom([100, 99], [10, 25]);
    expect(obv(c).at(-1)).toBe(-25);
  });

  it('reports relative volume against the 20-period average', () => {
    const volumes = [...Array(20).fill(100), 300];
    const c = candlesFrom(Array(21).fill(100), volumes);
    // Average of the last 20 bars including the 300 spike.
    const rv = last(relativeVolume(c, 20))!;
    expect(rv).toBeGreaterThan(2);
  });
});

describe('pivots', () => {
  it('computes classic levels from the prior H/L/C', () => {
    const p = classicPivots(110, 90, 100);
    expect(p.pivot).toBeCloseTo(100, 10);   // (110+90+100)/3
    expect(p.r1).toBeCloseTo(110, 10);      // 2*100 - 90
    expect(p.s1).toBeCloseTo(90, 10);       // 2*100 - 110
    expect(p.r2).toBeCloseTo(120, 10);      // 100 + (110-90)
    expect(p.s2).toBeCloseTo(80, 10);       // 100 - (110-90)
  });

  it('keeps resistances above supports', () => {
    const p = classicPivots(150, 100, 130);
    expect(p.r3).toBeGreaterThan(p.r2);
    expect(p.r2).toBeGreaterThan(p.r1);
    expect(p.s1).toBeGreaterThan(p.s2);
    expect(p.s2).toBeGreaterThan(p.s3);
  });
});

describe('crossover helpers', () => {
  it('detects an upward cross only on the bar it happens', () => {
    expect(crossedAbove([1, 3], [2, 2])).toBe(true);
    expect(crossedAbove([3, 4], [2, 2])).toBe(false); // already above
    expect(crossedAbove([3, 1], [2, 2])).toBe(false); // crossed down
  });

  it('detects a downward cross', () => {
    expect(crossedBelow([3, 1], [2, 2])).toBe(true);
    expect(crossedBelow([1, 0], [2, 2])).toBe(false);
  });

  it('returns false when either series has nulls at the edge', () => {
    expect(crossedAbove([null, 3], [2, 2])).toBe(false);
    expect(crossedAbove([1, 3], [null, 2])).toBe(false);
  });
});

describe('utility helpers', () => {
  it('last finds the final non-null value', () => {
    expect(last([1, 2, null])).toBe(2);
    expect(last([null, null])).toBeNull();
  });

  it('at indexes from the end', () => {
    expect(at([1, 2, 3], 0)).toBe(3);
    expect(at([1, 2, 3], 2)).toBe(1);
    expect(at([1, 2, 3], 9)).toBeNull();
  });

  it('percentileRank places a value within its sample', () => {
    expect(percentileRank([1, 2, 3, 4], 4)).toBe(100);
    expect(percentileRank([1, 2, 3, 4], 2)).toBe(50);
  });
});
