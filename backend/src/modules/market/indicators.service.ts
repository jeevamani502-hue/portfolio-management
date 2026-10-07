/**
 * Indicator series for charting.
 *
 * The maths lives in `analysis/indicators` and is computed here rather than
 * in the browser, so the line drawn on the chart is produced by the same
 * code that scores a setup and drives the scanner. A second implementation
 * in TypeScript on the client would drift, and then the chart would disagree
 * with the signal that was acted on — which is the worst kind of bug in a
 * tool like this, because both sides look right.
 *
 * Every series is returned aligned index-for-index with the candles, with
 * `null` wherever the indicator has no value yet (its warm-up period). The
 * chart skips nulls rather than drawing a line to zero.
 */
import {
  sma, ema, rsi, macd, bollingerBands, supertrend, vwap, atr, adx,
  type Candle,
} from '../../analysis/indicators/index.js';
import { toIst } from '../../utils/time.js';

/** Indicators that share the price axis. */
export type OverlayId = 'ema20' | 'ema50' | 'ema200' | 'sma50' | 'sma200' | 'vwap' | 'bb' | 'supertrend';
/** Indicators that need their own pane. */
export type PaneId = 'rsi' | 'macd' | 'atr' | 'adx';

export interface IndicatorLine {
  id: string;
  label: string;
  /** Aligned to the candle array; null during warm-up. */
  values: (number | null)[];
  /** Which pane this belongs to. 'price' shares the candle axis. */
  pane: 'price' | PaneId;
  /** Plain statement of what it is, shown on hover. */
  note: string;
}

/**
 * The default set.
 *
 * Chosen for coverage rather than count: one trend follower, one volatility
 * envelope, one momentum oscillator, and one that combines trend and
 * volatility. Stacking five momentum indicators that all read the same
 * price series produces agreement that looks like confirmation and is not.
 */
export const DEFAULT_OVERLAYS: OverlayId[] = ['ema20', 'ema50', 'ema200', 'supertrend'];
export const DEFAULT_PANES: PaneId[] = ['rsi', 'macd'];

const closesOf = (c: readonly Candle[]) => c.map((x) => x.close);

export function computeIndicators(
  candles: readonly Candle[],
  opts: { overlays?: OverlayId[]; panes?: PaneId[] } = {},
): IndicatorLine[] {
  const overlays = opts.overlays ?? DEFAULT_OVERLAYS;
  const panes = opts.panes ?? DEFAULT_PANES;
  const closes = closesOf(candles);
  const out: IndicatorLine[] = [];

  if (candles.length === 0) return out;

  // ── price overlays ────────────────────────────────────────────────────────

  for (const id of overlays) {
    switch (id) {
      case 'ema20':
        out.push({ id, label: 'EMA 20', pane: 'price', values: ema(closes, 20),
          note: 'Exponential moving average of the last 20 closes; weights recent bars more heavily than an SMA.' });
        break;
      case 'ema50':
        out.push({ id, label: 'EMA 50', pane: 'price', values: ema(closes, 50),
          note: 'Exponential moving average over 50 bars — a common medium-term trend reference.' });
        break;
      case 'ema200':
        out.push({ id, label: 'EMA 200', pane: 'price', values: ema(closes, 200),
          note: 'Exponential moving average over 200 bars. Widely watched, which is part of why it matters.' });
        break;
      case 'sma50':
        out.push({ id, label: 'SMA 50', pane: 'price', values: sma(closes, 50),
          note: 'Simple average of the last 50 closes, every bar weighted equally.' });
        break;
      case 'sma200':
        out.push({ id, label: 'SMA 200', pane: 'price', values: sma(closes, 200),
          note: 'Simple average of the last 200 closes.' });
        break;
      case 'vwap':
        out.push({
          id, label: 'VWAP', pane: 'price',
          // Anchored per IST trading day, which is what a session means here.
          values: vwap(candles, (c) => toIst(new Date(c.ts)).dateKey),
          note: 'Volume-weighted average price, re-anchored each trading day. Meaningful intraday; flat and uninformative on a daily chart.',
        });
        break;
      case 'bb': {
        const b = bollingerBands(closes, 20, 2);
        out.push({ id: 'bbUpper', label: 'Bollinger upper', pane: 'price', values: b.upper,
          note: 'Two standard deviations above the 20-bar mean. A touch is not a signal — price can ride the band.' });
        out.push({ id: 'bbMiddle', label: 'Bollinger mid', pane: 'price', values: b.middle,
          note: '20-bar simple moving average, the centre of the band.' });
        out.push({ id: 'bbLower', label: 'Bollinger lower', pane: 'price', values: b.lower,
          note: 'Two standard deviations below the 20-bar mean.' });
        break;
      }
      case 'supertrend': {
        const st = supertrend(candles, 10, 3);
        out.push({ id, label: 'Supertrend (10, 3)', pane: 'price', values: st.value,
          note: 'ATR-based trailing stop. Flips side when price closes through it; whipsaws in a range.' });
        break;
      }
    }
  }

  // ── separate panes ────────────────────────────────────────────────────────

  for (const id of panes) {
    switch (id) {
      case 'rsi':
        out.push({ id, label: 'RSI 14', pane: 'rsi', values: rsi(closes, 14),
          note: "Wilder's relative strength index. Above 70 and below 30 are conventional extremes, not instructions — a strong trend holds above 70 for weeks." });
        break;
      case 'macd': {
        const m = macd(closes, 12, 26, 9);
        out.push({ id: 'macd', label: 'MACD', pane: 'macd', values: m.macd,
          note: 'Difference between the 12- and 26-period EMAs.' });
        out.push({ id: 'macdSignal', label: 'Signal', pane: 'macd', values: m.signal,
          note: '9-period EMA of the MACD line.' });
        out.push({ id: 'macdHist', label: 'Histogram', pane: 'macd', values: m.histogram,
          note: 'MACD minus its signal line.' });
        break;
      }
      case 'atr':
        out.push({ id, label: 'ATR 14', pane: 'atr', values: atr(candles, 14),
          note: 'Average true range — typical bar size. Used here to place invalidation levels.' });
        break;
      case 'adx': {
        const a = adx(candles, 14);
        out.push({ id: 'adx', label: 'ADX 14', pane: 'adx', values: a.adx,
          note: 'Trend strength regardless of direction. Below 20 is usually a range.' });
        out.push({ id: 'diPlus', label: '+DI', pane: 'adx', values: a.plusDi, note: 'Positive directional indicator.' });
        out.push({ id: 'diMinus', label: '-DI', pane: 'adx', values: a.minusDi, note: 'Negative directional indicator.' });
        break;
      }
    }
  }

  return out;
}
