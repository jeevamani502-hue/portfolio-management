/**
 * Technical indicators — pure functions over OHLCV series.
 *
 * Conventions that hold throughout this file:
 *  · Input series are oldest-first.
 *  · Output arrays align 1:1 with the input; positions without enough history
 *    are `null`, never zero and never back-filled. A null means "cannot be
 *    computed", which is a real answer the UI renders honestly.
 *  · Nothing here touches the network, the clock, or the database. Every value
 *    is reproducible from its inputs, which is what lets the UI show its work.
 */

export interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number | null;
}

export type Series = ReadonlyArray<number>;
export type NullableSeries = ReadonlyArray<number | null>;

const EPS = 1e-12;

// ── moving averages ─────────────────────────────────────────────────────────

export function sma(values: Series, period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * EMA seeded with the SMA of the first `period` values — the standard
 * convention, and the one charting platforms use, so our numbers line up with
 * what the user sees elsewhere.
 */
export function ema(values: Series, period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (used by RSI, ATR, ADX). Equivalent to EMA with k = 1/n. */
export function wilderSmooth(values: Series, period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]!) / period;
    out[i] = prev;
  }
  return out;
}

// ── momentum ────────────────────────────────────────────────────────────────

/** Wilder's RSI. Returns 0–100. */
export function rsi(closes: Series, period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i += 1) {
    const diff = closes[i]! - closes[i - 1]!;
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }

  // Wilder seeds on the first `period` changes, i.e. indices 1..period.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    avgGain += gains[i]!;
    avgLoss += losses[i]!;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss < EPS ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    avgGain = (avgGain * (period - 1) + gains[i]!) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]!) / period;
    out[i] = avgLoss < EPS ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface MacdResult {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
}

export function macd(
  closes: Series,
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);

  const line: (number | null)[] = closes.map((_, i) => {
    const f = fastEma[i];
    const s = slowEma[i];
    return f !== null && f !== undefined && s !== null && s !== undefined ? f - s : null;
  });

  // The signal line is an EMA of the MACD line, computed only over the
  // contiguous defined region so the seeding matches standard charts.
  const firstDefined = line.findIndex((v) => v !== null);
  const signal: (number | null)[] = new Array(closes.length).fill(null);
  if (firstDefined >= 0) {
    const dense = line.slice(firstDefined) as number[];
    const sig = ema(dense, signalPeriod);
    for (let i = 0; i < sig.length; i += 1) signal[firstDefined + i] = sig[i]!;
  }

  const histogram = line.map((m, i) => {
    const s = signal[i];
    return m !== null && s !== null && s !== undefined ? m - s : null;
  });

  return { macd: line, signal, histogram };
}

export interface StochRsiResult {
  k: (number | null)[];
  d: (number | null)[];
}

/** Stochastic RSI: the stochastic oscillator applied to RSI values. */
export function stochRsi(
  closes: Series,
  rsiPeriod = 14,
  stochPeriod = 14,
  kSmooth = 3,
  dSmooth = 3,
): StochRsiResult {
  const r = rsi(closes, rsiPeriod);
  const raw: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i += 1) {
    if (i < stochPeriod - 1) continue;
    const window = r.slice(i - stochPeriod + 1, i + 1);
    if (window.some((v) => v === null)) continue;
    const vals = window as number[];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const cur = r[i]!;
    raw[i] = hi - lo < EPS ? 0 : ((cur - lo) / (hi - lo)) * 100;
  }

  const k = smoothNullable(raw, kSmooth);
  const d = smoothNullable(k, dSmooth);
  return { k, d };
}

/** SMA over a series that may contain nulls; a window with any null is null. */
export function smoothNullable(values: NullableSeries, period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 1) return values.slice() as (number | null)[];

  for (let i = period - 1; i < values.length; i += 1) {
    let sum = 0;
    let ok = true;
    for (let j = i - period + 1; j <= i; j += 1) {
      const v = values[j];
      if (v === null || v === undefined) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / period;
  }
  return out;
}

// ── volatility ──────────────────────────────────────────────────────────────

/** True range for each bar. Index 0 uses high−low (no prior close). */
export function trueRange(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1]!.close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: readonly Candle[], period = 14): (number | null)[] {
  return wilderSmooth(trueRange(candles), period);
}

export interface BollingerResult {
  upper: (number | null)[];
  middle: (number | null)[];
  lower: (number | null)[];
  bandwidth: (number | null)[];
  percentB: (number | null)[];
}

export function bollingerBands(closes: Series, period = 20, stdDevs = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  const bandwidth: (number | null)[] = new Array(closes.length).fill(null);
  const percentB: (number | null)[] = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i += 1) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (closes[j]! - mean) ** 2;
    // Population standard deviation, the standard for Bollinger Bands.
    const sd = Math.sqrt(variance / period);
    const u = mean + stdDevs * sd;
    const l = mean - stdDevs * sd;
    upper[i] = u;
    lower[i] = l;
    bandwidth[i] = mean > EPS ? ((u - l) / mean) * 100 : null;
    percentB[i] = u - l > EPS ? ((closes[i]! - l) / (u - l)) * 100 : null;
  }

  return { upper, middle, lower, bandwidth, percentB };
}

// ── trend strength ──────────────────────────────────────────────────────────

export interface AdxResult {
  adx: (number | null)[];
  plusDi: (number | null)[];
  minusDi: (number | null)[];
}

/** Wilder's ADX with +DI / −DI. */
export function adx(candles: readonly Candle[], period = 14): AdxResult {
  const n = candles.length;
  const out: AdxResult = {
    adx: new Array(n).fill(null),
    plusDi: new Array(n).fill(null),
    minusDi: new Array(n).fill(null),
  };
  if (n < period * 2) return out;

  const plusDm: number[] = [0];
  const minusDm: number[] = [0];
  const tr = trueRange(candles);

  for (let i = 1; i < n; i += 1) {
    const upMove = candles[i]!.high - candles[i - 1]!.high;
    const downMove = candles[i - 1]!.low - candles[i]!.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  const smoothTr = wilderSmooth(tr, period);
  const smoothPlus = wilderSmooth(plusDm, period);
  const smoothMinus = wilderSmooth(minusDm, period);

  const dx: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i += 1) {
    const t = smoothTr[i];
    const p = smoothPlus[i];
    const m = smoothMinus[i];
    if (t === null || t === undefined || t < EPS || p === null || p === undefined || m === null || m === undefined) {
      continue;
    }
    const pdi = (p / t) * 100;
    const mdi = (m / t) * 100;
    out.plusDi[i] = pdi;
    out.minusDi[i] = mdi;
    const sum = pdi + mdi;
    dx[i] = sum < EPS ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }

  // ADX is Wilder's smoothing of DX over the contiguous defined region.
  const first = dx.findIndex((v) => v !== null);
  if (first >= 0) {
    const dense = dx.slice(first).filter((v): v is number => v !== null);
    const smoothed = wilderSmooth(dense, period);
    for (let i = 0; i < smoothed.length; i += 1) {
      if (smoothed[i] !== null) out.adx[first + i] = smoothed[i]!;
    }
  }

  return out;
}

// ── supertrend ──────────────────────────────────────────────────────────────

export interface SupertrendResult {
  value: (number | null)[];
  direction: (1 | -1 | null)[]; // 1 = bullish (price above), −1 = bearish
}

export function supertrend(
  candles: readonly Candle[],
  period = 10,
  multiplier = 3,
): SupertrendResult {
  const n = candles.length;
  const value: (number | null)[] = new Array(n).fill(null);
  const direction: (1 | -1 | null)[] = new Array(n).fill(null);
  const atrSeries = atr(candles, period);

  let finalUpper = 0;
  let finalLower = 0;
  let prevDir: 1 | -1 = 1;
  let started = false;

  for (let i = 0; i < n; i += 1) {
    const a = atrSeries[i];
    if (a === null || a === undefined) continue;

    const c = candles[i]!;
    const mid = (c.high + c.low) / 2;
    const basicUpper = mid + multiplier * a;
    const basicLower = mid - multiplier * a;

    if (!started) {
      finalUpper = basicUpper;
      finalLower = basicLower;
      prevDir = c.close > basicUpper ? 1 : -1;
      started = true;
    } else {
      const prevClose = candles[i - 1]!.close;
      finalUpper =
        basicUpper < finalUpper || prevClose > finalUpper ? basicUpper : finalUpper;
      finalLower =
        basicLower > finalLower || prevClose < finalLower ? basicLower : finalLower;

      if (prevDir === 1) prevDir = c.close < finalLower ? -1 : 1;
      else prevDir = c.close > finalUpper ? 1 : -1;
    }

    direction[i] = prevDir;
    value[i] = prevDir === 1 ? finalLower : finalUpper;
  }

  return { value, direction };
}

// ── volume ──────────────────────────────────────────────────────────────────

/**
 * Session-anchored VWAP.
 *
 * Genuine VWAP resets at each session open. `sessionKey` maps a candle to its
 * session (the IST date for intraday bars). For daily and higher timeframes a
 * rolling VWAP is meaningless, so callers should use the exchange-reported
 * average price instead — which is why `NormalizedQuote.avgPrice` exists.
 */
export function vwap(
  candles: readonly Candle[],
  sessionKey: (c: Candle) => string,
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  let currentSession: string | null = null;
  let cumPv = 0;
  let cumVol = 0;

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]!;
    const key = sessionKey(c);
    if (key !== currentSession) {
      currentSession = key;
      cumPv = 0;
      cumVol = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    cumPv += typical * c.volume;
    cumVol += c.volume;
    out[i] = cumVol > EPS ? cumPv / cumVol : null;
  }
  return out;
}

/** On-balance volume. */
export function obv(candles: readonly Candle[]): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i += 1) {
    const prev = out[i - 1]!;
    const c = candles[i]!;
    const pc = candles[i - 1]!.close;
    out[i] = c.close > pc ? prev + c.volume : c.close < pc ? prev - c.volume : prev;
  }
  return out;
}

/** Ratio of current volume to its average — the "volume shocker" measure. */
export function relativeVolume(candles: readonly Candle[], period = 20): (number | null)[] {
  const volumes = candles.map((c) => c.volume);
  const avg = sma(volumes, period);
  return candles.map((c, i) => {
    const a = avg[i];
    return a !== null && a !== undefined && a > EPS ? c.volume / a : null;
  });
}

// ── pivot points ────────────────────────────────────────────────────────────

export interface PivotLevels {
  pivot: number;
  r1: number;
  r2: number;
  r3: number;
  s1: number;
  s2: number;
  s3: number;
  method: 'classic' | 'fibonacci' | 'camarilla';
}

/** Classic floor-trader pivots from the previous period's H/L/C. */
export function classicPivots(high: number, low: number, close: number): PivotLevels {
  const p = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot: p,
    r1: 2 * p - low,
    s1: 2 * p - high,
    r2: p + range,
    s2: p - range,
    r3: high + 2 * (p - low),
    s3: low - 2 * (high - p),
    method: 'classic',
  };
}

export function fibonacciPivots(high: number, low: number, close: number): PivotLevels {
  const p = (high + low + close) / 3;
  const range = high - low;
  return {
    pivot: p,
    r1: p + 0.382 * range,
    r2: p + 0.618 * range,
    r3: p + range,
    s1: p - 0.382 * range,
    s2: p - 0.618 * range,
    s3: p - range,
    method: 'fibonacci',
  };
}

export function camarillaPivots(high: number, low: number, close: number): PivotLevels {
  const range = high - low;
  return {
    pivot: (high + low + close) / 3,
    r1: close + (range * 1.1) / 12,
    r2: close + (range * 1.1) / 6,
    r3: close + (range * 1.1) / 4,
    s1: close - (range * 1.1) / 12,
    s2: close - (range * 1.1) / 6,
    s3: close - (range * 1.1) / 4,
    method: 'camarilla',
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Last non-null value of a series. */
export function last<T>(series: ReadonlyArray<T | null>): T | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

/** Value `n` bars back from the end, or null. */
export function at<T>(series: ReadonlyArray<T | null>, fromEnd: number): T | null {
  const idx = series.length - 1 - fromEnd;
  if (idx < 0 || idx >= series.length) return null;
  return series[idx] ?? null;
}

/** True when `a` crossed above `b` on the most recent bar. */
export function crossedAbove(a: NullableSeries, b: NullableSeries): boolean {
  const aNow = at(a, 0);
  const aPrev = at(a, 1);
  const bNow = at(b, 0);
  const bPrev = at(b, 1);
  if (aNow === null || aPrev === null || bNow === null || bPrev === null) return false;
  return aPrev <= bPrev && aNow > bNow;
}

export function crossedBelow(a: NullableSeries, b: NullableSeries): boolean {
  const aNow = at(a, 0);
  const aPrev = at(a, 1);
  const bNow = at(b, 0);
  const bPrev = at(b, 1);
  if (aNow === null || aPrev === null || bNow === null || bPrev === null) return false;
  return aPrev >= bPrev && aNow < bNow;
}

/** Standard deviation of a numeric sample (population). */
export function stdDev(values: Series): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Percentile rank (0–100) of `value` within `sample`. */
export function percentileRank(sample: Series, value: number): number | null {
  if (sample.length === 0) return null;
  const below = sample.filter((v) => v <= value).length;
  return (below / sample.length) * 100;
}
