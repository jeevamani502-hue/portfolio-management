/**
 * Market structure: swing pivots, trend classification, support/resistance.
 *
 * "Structure" is the part of technical analysis most often hand-waved. Here it
 * is explicit and reproducible: a pivot is a bar whose high exceeds the highs
 * of `lookback` bars on both sides, a level is a price cluster touched at least
 * `minTouches` times, and trend is a stated rule over the sequence of pivots.
 * Every level the UI draws can be traced back to the bars that formed it.
 */
import type { Candle } from './indicators/index.js';
import { atr, last, sma } from './indicators/index.js';

export interface SwingPoint {
  index: number;
  ts: string;
  price: number;
  type: 'HIGH' | 'LOW';
}

/**
 * Fractal swing detection. A swing high at i requires
 * high[i] > high[i±1..lookback]. Uses strict comparison on the left and
 * non-strict on the right so a flat top resolves to a single pivot.
 */
export function findSwings(candles: readonly Candle[], lookback = 3): SwingPoint[] {
  const out: SwingPoint[] = [];
  if (candles.length < lookback * 2 + 1) return out;

  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j += 1) {
      const leftC = candles[i - j]!;
      const rightC = candles[i + j]!;
      if (c.high <= leftC.high || c.high < rightC.high) isHigh = false;
      if (c.low >= leftC.low || c.low > rightC.low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) out.push({ index: i, ts: c.ts, price: c.high, type: 'HIGH' });
    else if (isLow) out.push({ index: i, ts: c.ts, price: c.low, type: 'LOW' });
  }
  return out;
}

export type TrendLabel =
  | 'STRONG_UPTREND'
  | 'UPTREND'
  | 'RANGE'
  | 'DOWNTREND'
  | 'STRONG_DOWNTREND'
  | 'UNDETERMINED';

export interface TrendAssessment {
  label: TrendLabel;
  /** 0–100, how cleanly the rules are satisfied. */
  strength: number;
  /** The specific observations behind the label. */
  reasons: string[];
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  /** Close relative to SMA50/SMA200, when enough history exists. */
  aboveSma50: boolean | null;
  aboveSma200: boolean | null;
  sma50AboveSma200: boolean | null;
}

/**
 * Classify trend from the last few swings plus moving-average position.
 *
 * Deliberately conservative: without at least two highs and two lows we return
 * UNDETERMINED rather than guessing from price direction alone.
 */
export function classifyTrend(candles: readonly Candle[], swings: SwingPoint[]): TrendAssessment {
  const closes = candles.map((c) => c.close);
  const sma50 = last(sma(closes, 50));
  const sma200 = last(sma(closes, 200));
  const close = closes.at(-1) ?? null;

  const aboveSma50 = close !== null && sma50 !== null ? close > sma50 : null;
  const aboveSma200 = close !== null && sma200 !== null ? close > sma200 : null;
  const sma50AboveSma200 = sma50 !== null && sma200 !== null ? sma50 > sma200 : null;

  const highs = swings.filter((s) => s.type === 'HIGH').slice(-3);
  const lows = swings.filter((s) => s.type === 'LOW').slice(-3);

  const higherHighs = highs.length >= 2 && highs.at(-1)!.price > highs.at(-2)!.price;
  const lowerHighs = highs.length >= 2 && highs.at(-1)!.price < highs.at(-2)!.price;
  const higherLows = lows.length >= 2 && lows.at(-1)!.price > lows.at(-2)!.price;
  const lowerLows = lows.length >= 2 && lows.at(-1)!.price < lows.at(-2)!.price;

  const reasons: string[] = [];
  let score = 0;

  if (higherHighs) { score += 2; reasons.push('Higher high on the most recent swing'); }
  if (higherLows) { score += 2; reasons.push('Higher low on the most recent swing'); }
  if (lowerHighs) { score -= 2; reasons.push('Lower high on the most recent swing'); }
  if (lowerLows) { score -= 2; reasons.push('Lower low on the most recent swing'); }

  if (aboveSma50 === true) { score += 1; reasons.push('Price above the 50-period SMA'); }
  if (aboveSma50 === false) { score -= 1; reasons.push('Price below the 50-period SMA'); }
  if (aboveSma200 === true) { score += 1; reasons.push('Price above the 200-period SMA'); }
  if (aboveSma200 === false) { score -= 1; reasons.push('Price below the 200-period SMA'); }
  if (sma50AboveSma200 === true) { score += 1; reasons.push('50 SMA above 200 SMA'); }
  if (sma50AboveSma200 === false) { score -= 1; reasons.push('50 SMA below 200 SMA'); }

  if (highs.length < 2 || lows.length < 2) {
    return {
      label: 'UNDETERMINED',
      strength: 0,
      reasons: ['Not enough completed swings to classify structure'],
      higherHighs, higherLows, lowerHighs, lowerLows,
      aboveSma50, aboveSma200, sma50AboveSma200,
    };
  }

  const maxScore = 7;
  const strength = Math.round((Math.abs(score) / maxScore) * 100);

  let label: TrendLabel;
  if (score >= 5) label = 'STRONG_UPTREND';
  else if (score >= 2) label = 'UPTREND';
  else if (score <= -5) label = 'STRONG_DOWNTREND';
  else if (score <= -2) label = 'DOWNTREND';
  else label = 'RANGE';

  return {
    label, strength, reasons,
    higherHighs, higherLows, lowerHighs, lowerLows,
    aboveSma50, aboveSma200, sma50AboveSma200,
  };
}

export interface PriceLevel {
  price: number;
  /** How many swing points formed this cluster. */
  touches: number;
  /** 0–100 composite of touches, recency and volume at the level. */
  strength: number;
  type: 'SUPPORT' | 'RESISTANCE';
  /** Indices of the candles that contributed. */
  formedBy: number[];
  lastTouchTs: string;
}

export interface SupportResistanceOptions {
  /** Cluster width as a multiple of ATR. */
  atrMultiple?: number;
  minTouches?: number;
  /** Only consider swings within this many bars of the end. */
  lookbackBars?: number;
  maxLevels?: number;
}

/**
 * Cluster swing points into support/resistance bands.
 *
 * Tolerance is ATR-scaled rather than a fixed percentage, so a ₹50 stock and a
 * ₹50,000 index both get sensible bands without per-symbol tuning.
 */
export function findSupportResistance(
  candles: readonly Candle[],
  swings: SwingPoint[],
  currentPrice: number,
  opts: SupportResistanceOptions = {},
): { supports: PriceLevel[]; resistances: PriceLevel[] } {
  const {
    atrMultiple = 0.75,
    minTouches = 2,
    lookbackBars = 250,
    maxLevels = 5,
  } = opts;

  const atrNow = last(atr(candles, 14));
  // Fall back to a 0.5% band only when ATR cannot be computed at all.
  const tolerance = atrNow !== null ? atrNow * atrMultiple : currentPrice * 0.005;
  if (tolerance <= 0) return { supports: [], resistances: [] };

  const cutoff = Math.max(0, candles.length - lookbackBars);
  const relevant = swings.filter((s) => s.index >= cutoff);

  // Greedy clustering over price-sorted swings.
  const sorted = [...relevant].sort((a, b) => a.price - b.price);
  const clusters: SwingPoint[][] = [];
  for (const s of sorted) {
    const current = clusters.at(-1);
    if (current && Math.abs(s.price - current[0]!.price) <= tolerance) current.push(s);
    else clusters.push([s]);
  }

  const levels: PriceLevel[] = clusters
    .filter((c) => c.length >= minTouches)
    .map((cluster) => {
      const price = cluster.reduce((sum, s) => sum + s.price, 0) / cluster.length;
      const lastIndex = Math.max(...cluster.map((s) => s.index));
      const recency = candles.length > 0 ? lastIndex / candles.length : 0;

      // Volume traded at the level, relative to average — a level defended on
      // heavy volume matters more than one touched on a quiet day.
      const avgVol =
        candles.reduce((sum, c) => sum + c.volume, 0) / Math.max(1, candles.length);
      const clusterVol =
        cluster.reduce((sum, s) => sum + (candles[s.index]?.volume ?? 0), 0) / cluster.length;
      const volRatio = avgVol > 0 ? Math.min(2, clusterVol / avgVol) : 1;

      const strength = Math.round(
        Math.min(100, cluster.length * 20 + recency * 30 + volRatio * 15),
      );

      return {
        price,
        touches: cluster.length,
        strength,
        type: price < currentPrice ? ('SUPPORT' as const) : ('RESISTANCE' as const),
        formedBy: cluster.map((s) => s.index),
        lastTouchTs: candles[lastIndex]?.ts ?? cluster.at(-1)!.ts,
      };
    });

  const supports = levels
    .filter((l) => l.type === 'SUPPORT')
    .sort((a, b) => b.price - a.price) // nearest support first
    .slice(0, maxLevels);

  const resistances = levels
    .filter((l) => l.type === 'RESISTANCE')
    .sort((a, b) => a.price - b.price) // nearest resistance first
    .slice(0, maxLevels);

  return { supports, resistances };
}

export interface RangeStats {
  high: number;
  low: number;
  /** Where the current price sits inside the range, 0–100. */
  positionPct: number;
  /** Range width as a percentage of the low. */
  widthPct: number;
}

export function rangeStats(
  candles: readonly Candle[],
  bars: number,
  currentPrice: number,
): RangeStats | null {
  const window = candles.slice(-bars);
  if (window.length === 0) return null;
  const high = Math.max(...window.map((c) => c.high));
  const low = Math.min(...window.map((c) => c.low));
  if (!Number.isFinite(high) || !Number.isFinite(low) || high <= low) return null;
  return {
    high,
    low,
    positionPct: ((currentPrice - low) / (high - low)) * 100,
    widthPct: ((high - low) / low) * 100,
  };
}

/**
 * Bullish/bearish RSI divergence against price over the recent swings.
 * Returns null when there are too few swings to compare.
 */
export function detectDivergence(
  candles: readonly Candle[],
  rsiSeries: ReadonlyArray<number | null>,
  swings: SwingPoint[],
): { type: 'BULLISH' | 'BEARISH'; detail: string } | null {
  const lows = swings.filter((s) => s.type === 'LOW').slice(-2);
  const highs = swings.filter((s) => s.type === 'HIGH').slice(-2);

  if (lows.length === 2) {
    const [a, b] = lows as [SwingPoint, SwingPoint];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price < a.price && rb > ra) {
      return {
        type: 'BULLISH',
        detail: `Price made a lower low (${a.price.toFixed(2)} → ${b.price.toFixed(2)}) while RSI made a higher low (${ra.toFixed(1)} → ${rb.toFixed(1)})`,
      };
    }
  }

  if (highs.length === 2) {
    const [a, b] = highs as [SwingPoint, SwingPoint];
    const ra = rsiSeries[a.index];
    const rb = rsiSeries[b.index];
    if (ra != null && rb != null && b.price > a.price && rb < ra) {
      return {
        type: 'BEARISH',
        detail: `Price made a higher high (${a.price.toFixed(2)} → ${b.price.toFixed(2)}) while RSI made a lower high (${ra.toFixed(1)} → ${rb.toFixed(1)})`,
      };
    }
  }

  return null;
}
