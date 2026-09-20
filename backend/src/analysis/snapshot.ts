/**
 * The TechnicalSnapshot: one object holding every computed indicator for a
 * symbol at a timeframe, plus the structure derived from it.
 *
 * This is the single input to the signal engine, the scanner, the AI evidence
 * bundle and the API response — so every consumer sees exactly the same
 * numbers, and a value shown on the chart cannot disagree with the value the
 * AI was given.
 */
import {
  sma, ema, rsi, macd, adx, atr, bollingerBands, supertrend, stochRsi,
  vwap, obv, relativeVolume, classicPivots, fibonacciPivots, camarillaPivots,
  last, at, crossedAbove, crossedBelow, percentileRank,
  type Candle, type PivotLevels,
} from './indicators/index.js';
import {
  findSwings, classifyTrend, findSupportResistance, rangeStats, detectDivergence,
  type SwingPoint, type TrendAssessment, type PriceLevel, type RangeStats,
} from './structure.js';
import { toIst, isIntraday, type Timeframe } from '../utils/time.js';

export interface MovingAverages {
  sma20: number | null;
  sma50: number | null;
  sma100: number | null;
  sma200: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
}

export interface MomentumBlock {
  rsi14: number | null;
  rsi14Prev: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  macdBullishCross: boolean;
  macdBearishCross: boolean;
  stochRsiK: number | null;
  stochRsiD: number | null;
}

export interface VolatilityBlock {
  atr14: number | null;
  /** ATR as a percentage of price — comparable across instruments. */
  atrPct: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbWidth: number | null;
  bbPercentB: number | null;
  /** Percentile of current BB width within its own history (squeeze detection). */
  bbWidthPercentile: number | null;
}

export interface VolumeBlock {
  volume: number | null;
  avgVolume20: number | null;
  relativeVolume: number | null;
  obv: number | null;
  obvSlope5: number | null;
  /** True when volume is rising while price rises. */
  volumeConfirmsPrice: boolean | null;
}

export interface TrendBlock {
  adx14: number | null;
  plusDi: number | null;
  minusDi: number | null;
  supertrend: number | null;
  supertrendDirection: 1 | -1 | null;
  assessment: TrendAssessment;
}

export interface TechnicalSnapshot {
  symbol: string;
  timeframe: Timeframe;
  /** Timestamp of the last candle used — the true "as of" for everything here. */
  asOf: string;
  candleCount: number;

  price: {
    close: number;
    open: number;
    high: number;
    low: number;
    prevClose: number | null;
    change: number | null;
    changePct: number | null;
  };

  movingAverages: MovingAverages;
  momentum: MomentumBlock;
  volatility: VolatilityBlock;
  volume: VolumeBlock;
  trend: TrendBlock;

  vwap: number | null;
  priceVsVwapPct: number | null;

  pivots: {
    classic: PivotLevels | null;
    fibonacci: PivotLevels | null;
    camarilla: PivotLevels | null;
  };

  structure: {
    swings: SwingPoint[];
    supports: PriceLevel[];
    resistances: PriceLevel[];
    nearestSupport: PriceLevel | null;
    nearestResistance: PriceLevel | null;
    range20: RangeStats | null;
    range52w: RangeStats | null;
    divergence: { type: 'BULLISH' | 'BEARISH'; detail: string } | null;
  };

  /** Fields that could not be computed, with why. Surfaced in the UI. */
  insufficient: Array<{ field: string; required: number; available: number }>;
}

const MIN_BARS_FOR_ANALYSIS = 30;

export class InsufficientHistoryError extends Error {
  constructor(
    readonly required: number,
    readonly available: number,
  ) {
    super(`Insufficient candle history: need at least ${required} bars, have ${available}`);
    this.name = 'InsufficientHistoryError';
  }
}

/**
 * Build the snapshot. Throws only when there is not enough history for *any*
 * meaningful analysis; otherwise individual fields are null and listed in
 * `insufficient`, so the UI can say precisely what is missing.
 */
export function buildSnapshot(
  symbol: string,
  timeframe: Timeframe,
  candles: readonly Candle[],
): TechnicalSnapshot {
  if (candles.length < MIN_BARS_FOR_ANALYSIS) {
    throw new InsufficientHistoryError(MIN_BARS_FOR_ANALYSIS, candles.length);
  }

  const closes = candles.map((c) => c.close);
  const lastCandle = candles.at(-1)!;
  const prevCandle = candles.at(-2) ?? null;
  const n = candles.length;

  const insufficient: Array<{ field: string; required: number; available: number }> = [];
  const need = (field: string, required: number) => {
    if (n < required) insufficient.push({ field, required, available: n });
  };
  need('sma50', 50);
  need('sma100', 100);
  need('sma200', 200);
  need('adx14', 28);

  // ── moving averages ──
  const movingAverages: MovingAverages = {
    sma20: last(sma(closes, 20)),
    sma50: last(sma(closes, 50)),
    sma100: last(sma(closes, 100)),
    sma200: last(sma(closes, 200)),
    ema9: last(ema(closes, 9)),
    ema20: last(ema(closes, 20)),
    ema50: last(ema(closes, 50)),
  };

  // ── momentum ──
  const rsiSeries = rsi(closes, 14);
  const macdRes = macd(closes);
  const stoch = stochRsi(closes);

  const momentum: MomentumBlock = {
    rsi14: last(rsiSeries),
    rsi14Prev: at(rsiSeries, 1),
    macd: last(macdRes.macd),
    macdSignal: last(macdRes.signal),
    macdHistogram: last(macdRes.histogram),
    macdBullishCross: crossedAbove(macdRes.macd, macdRes.signal),
    macdBearishCross: crossedBelow(macdRes.macd, macdRes.signal),
    stochRsiK: last(stoch.k),
    stochRsiD: last(stoch.d),
  };

  // ── volatility ──
  const atrSeries = atr(candles, 14);
  const bb = bollingerBands(closes, 20, 2);
  const atr14 = last(atrSeries);
  const bbWidthHistory = bb.bandwidth.filter((v): v is number => v !== null);
  const bbWidthNow = last(bb.bandwidth);

  const volatility: VolatilityBlock = {
    atr14,
    atrPct: atr14 !== null && lastCandle.close > 0 ? (atr14 / lastCandle.close) * 100 : null,
    bbUpper: last(bb.upper),
    bbMiddle: last(bb.middle),
    bbLower: last(bb.lower),
    bbWidth: bbWidthNow,
    bbPercentB: last(bb.percentB),
    bbWidthPercentile:
      bbWidthNow !== null && bbWidthHistory.length >= 20
        ? percentileRank(bbWidthHistory, bbWidthNow)
        : null,
  };

  // ── volume ──
  const relVol = relativeVolume(candles, 20);
  const obvSeries = obv(candles);
  const avgVol20 = last(sma(candles.map((c) => c.volume), 20));
  const obvNow = obvSeries.at(-1) ?? null;
  const obv5Back = obvSeries.length > 5 ? obvSeries[obvSeries.length - 6]! : null;
  const priceRising = prevCandle ? lastCandle.close > prevCandle.close : null;
  const volumeRising =
    prevCandle && avgVol20 !== null ? lastCandle.volume > prevCandle.volume : null;

  const volume: VolumeBlock = {
    volume: lastCandle.volume,
    avgVolume20: avgVol20,
    relativeVolume: last(relVol),
    obv: obvNow,
    obvSlope5: obvNow !== null && obv5Back !== null ? obvNow - obv5Back : null,
    volumeConfirmsPrice:
      priceRising === null || volumeRising === null ? null : priceRising === volumeRising,
  };

  // ── trend ──
  const adxRes = adx(candles, 14);
  const st = supertrend(candles, 10, 3);
  const swings = findSwings(candles, 3);
  const assessment = classifyTrend(candles, swings);

  const trend: TrendBlock = {
    adx14: last(adxRes.adx),
    plusDi: last(adxRes.plusDi),
    minusDi: last(adxRes.minusDi),
    supertrend: last(st.value),
    supertrendDirection: last(st.direction),
    assessment,
  };

  // ── VWAP ──
  // Only meaningful intraday, where it resets each session. On daily+ bars the
  // exchange-reported average price is the right number, so we return null
  // rather than a rolling average masquerading as VWAP.
  let vwapNow: number | null = null;
  if (isIntraday(timeframe)) {
    const vwapSeries = vwap(candles, (c) => toIst(new Date(c.ts)).dateKey);
    vwapNow = last(vwapSeries);
  }

  // ── pivots (from the previous completed bar) ──
  const pivotSource = prevCandle;
  const pivots = pivotSource
    ? {
        classic: classicPivots(pivotSource.high, pivotSource.low, pivotSource.close),
        fibonacci: fibonacciPivots(pivotSource.high, pivotSource.low, pivotSource.close),
        camarilla: camarillaPivots(pivotSource.high, pivotSource.low, pivotSource.close),
      }
    : { classic: null, fibonacci: null, camarilla: null };

  // ── structure ──
  const { supports, resistances } = findSupportResistance(candles, swings, lastCandle.close);
  const barsIn52Weeks = timeframe === '1d' ? 250 : candles.length;

  const structure: TechnicalSnapshot['structure'] = {
    swings: swings.slice(-12),
    supports,
    resistances,
    nearestSupport: supports[0] ?? null,
    nearestResistance: resistances[0] ?? null,
    range20: rangeStats(candles, 20, lastCandle.close),
    range52w: rangeStats(candles, barsIn52Weeks, lastCandle.close),
    divergence: detectDivergence(candles, rsiSeries, swings),
  };

  const prevClose = prevCandle?.close ?? null;

  return {
    symbol,
    timeframe,
    asOf: lastCandle.ts,
    candleCount: n,
    price: {
      close: lastCandle.close,
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      prevClose,
      change: prevClose !== null ? lastCandle.close - prevClose : null,
      changePct:
        prevClose !== null && prevClose > 0
          ? ((lastCandle.close - prevClose) / prevClose) * 100
          : null,
    },
    movingAverages,
    momentum,
    volatility,
    volume,
    trend,
    vwap: vwapNow,
    priceVsVwapPct:
      vwapNow !== null && vwapNow > 0 ? ((lastCandle.close - vwapNow) / vwapNow) * 100 : null,
    pivots,
    structure,
    insufficient,
  };
}
