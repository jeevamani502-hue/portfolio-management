/**
 * Built-in backtest strategies.
 *
 * Each is a pure function of (candles, index, position) that sees only bars
 * up to `index` — the engine enforces this by slicing, but the strategies are
 * written to respect it anyway so they remain correct if reused.
 *
 * Indicators are recomputed per bar here for clarity. That is O(n²) over a
 * long series; the engine caches per-run where it matters, and for the
 * timeframes this platform backtests the cost is acceptable against the
 * benefit of strategies that are obviously correct by inspection.
 */
import {
  ema, sma, rsi, atr, supertrend, macd, vwap, last, at,
  type Candle,
} from '../indicators/index.js';
import { toIst } from '../../utils/time.js';
import type { Strategy, BacktestSignal } from './engine.js';

export interface StrategyDefinition {
  key: string;
  name: string;
  description: string;
  params: Record<string, { label: string; default: number; min: number; max: number }>;
  build: (params: Record<string, number>) => Strategy;
}

const HOLD: BacktestSignal = { action: 'HOLD' };

/** EMA crossover with an ATR stop. */
const emaCrossover: StrategyDefinition = {
  key: 'ema_crossover',
  name: 'EMA crossover',
  description:
    'Enters long when the fast EMA crosses above the slow EMA, exits on the reverse cross. Stop placed at a multiple of ATR below entry.',
  params: {
    fast: { label: 'Fast EMA period', default: 20, min: 2, max: 100 },
    slow: { label: 'Slow EMA period', default: 50, min: 5, max: 300 },
    atrMultiple: { label: 'ATR stop multiple', default: 2, min: 0.5, max: 10 },
  },
  build: (p) => (candles, index, position) => {
    const fast = Math.round(p['fast'] ?? 20);
    const slow = Math.round(p['slow'] ?? 50);
    const atrMult = p['atrMultiple'] ?? 2;
    if (index < slow + 2) return HOLD;

    const window = candles.slice(0, index + 1);
    const closes = window.map((c) => c.close);
    const fastEma = ema(closes, fast);
    const slowEma = ema(closes, slow);

    const fNow = last(fastEma);
    const fPrev = at(fastEma, 1);
    const sNow = last(slowEma);
    const sPrev = at(slowEma, 1);
    if (fNow === null || fPrev === null || sNow === null || sPrev === null) return HOLD;

    const crossedUp = fPrev <= sPrev && fNow > sNow;
    const crossedDown = fPrev >= sPrev && fNow < sNow;

    if (!position && crossedUp) {
      const a = last(atr(window, 14));
      const price = window.at(-1)!.close;
      return {
        action: 'ENTER_LONG',
        ...(a !== null ? { stop: price - a * atrMult } : {}),
        reason: `EMA${fast} crossed above EMA${slow}`,
      };
    }
    if (position && crossedDown) {
      return { action: 'EXIT', reason: `EMA${fast} crossed below EMA${slow}` };
    }
    return HOLD;
  },
};

/** RSI mean reversion. */
const rsiStrategy: StrategyDefinition = {
  key: 'rsi_reversion',
  name: 'RSI mean reversion',
  description:
    'Enters long when RSI closes back above the oversold threshold, exits when RSI reaches the overbought threshold. Counter-trend by design.',
  params: {
    period: { label: 'RSI period', default: 14, min: 2, max: 50 },
    oversold: { label: 'Oversold threshold', default: 30, min: 5, max: 45 },
    overbought: { label: 'Overbought threshold', default: 70, min: 55, max: 95 },
    atrMultiple: { label: 'ATR stop multiple', default: 2.5, min: 0.5, max: 10 },
  },
  build: (p) => (candles, index, position) => {
    const period = Math.round(p['period'] ?? 14);
    const oversold = p['oversold'] ?? 30;
    const overbought = p['overbought'] ?? 70;
    const atrMult = p['atrMultiple'] ?? 2.5;
    if (index < period + 3) return HOLD;

    const window = candles.slice(0, index + 1);
    const r = rsi(window.map((c) => c.close), period);
    const now = last(r);
    const prev = at(r, 1);
    if (now === null || prev === null) return HOLD;

    // Enter on the bar that closes back ABOVE oversold, not while below it —
    // buying a falling RSI is how mean-reversion backtests bleed.
    if (!position && prev < oversold && now >= oversold) {
      const a = last(atr(window, 14));
      const price = window.at(-1)!.close;
      return {
        action: 'ENTER_LONG',
        ...(a !== null ? { stop: price - a * atrMult } : {}),
        reason: `RSI recovered from ${prev.toFixed(1)} to ${now.toFixed(1)}, back above ${oversold}`,
      };
    }
    if (position && now >= overbought) {
      return { action: 'EXIT', reason: `RSI reached ${now.toFixed(1)}, at or above ${overbought}` };
    }
    return HOLD;
  },
};

/** N-bar breakout (Donchian). */
const breakoutStrategy: StrategyDefinition = {
  key: 'breakout',
  name: 'Donchian breakout',
  description:
    'Enters long when the close exceeds the highest high of the lookback window, exits when it falls below the lowest low of the exit window.',
  params: {
    entryLookback: { label: 'Entry lookback bars', default: 20, min: 5, max: 200 },
    exitLookback: { label: 'Exit lookback bars', default: 10, min: 3, max: 100 },
    atrMultiple: { label: 'ATR stop multiple', default: 2, min: 0.5, max: 10 },
    volumeMultiple: { label: 'Minimum volume vs average', default: 1, min: 0, max: 5 },
  },
  build: (p) => (candles, index, position) => {
    const entryLb = Math.round(p['entryLookback'] ?? 20);
    const exitLb = Math.round(p['exitLookback'] ?? 10);
    const atrMult = p['atrMultiple'] ?? 2;
    const volMult = p['volumeMultiple'] ?? 1;
    if (index < entryLb + 2) return HOLD;

    const window = candles.slice(0, index + 1);
    const bar = window.at(-1)!;

    // Prior window EXCLUDES the current bar, or the breakout is trivially true.
    const priorHigh = Math.max(...window.slice(-entryLb - 1, -1).map((c) => c.high));
    const priorLow = Math.min(...window.slice(-exitLb - 1, -1).map((c) => c.low));

    if (!position && bar.close > priorHigh) {
      if (volMult > 0) {
        const avgVol = last(sma(window.map((c) => c.volume), 20));
        if (avgVol !== null && avgVol > 0 && bar.volume < avgVol * volMult) return HOLD;
      }
      const a = last(atr(window, 14));
      return {
        action: 'ENTER_LONG',
        ...(a !== null ? { stop: bar.close - a * atrMult } : {}),
        reason: `Close ${bar.close.toFixed(2)} exceeded the ${entryLb}-bar high of ${priorHigh.toFixed(2)}`,
      };
    }
    if (position && bar.close < priorLow) {
      return {
        action: 'EXIT',
        reason: `Close ${bar.close.toFixed(2)} fell below the ${exitLb}-bar low of ${priorLow.toFixed(2)}`,
      };
    }
    return HOLD;
  },
};

/** Supertrend flip. */
const supertrendStrategy: StrategyDefinition = {
  key: 'supertrend',
  name: 'Supertrend',
  description: 'Enters long when Supertrend flips bullish and exits when it flips bearish.',
  params: {
    period: { label: 'ATR period', default: 10, min: 3, max: 50 },
    multiplier: { label: 'ATR multiplier', default: 3, min: 1, max: 10 },
  },
  build: (p) => (candles, index, position) => {
    const period = Math.round(p['period'] ?? 10);
    const mult = p['multiplier'] ?? 3;
    if (index < period + 5) return HOLD;

    const window = candles.slice(0, index + 1);
    const st = supertrend(window, period, mult);
    const dirNow = last(st.direction);
    const dirPrev = at(st.direction, 1);
    if (dirNow === null || dirPrev === null) return HOLD;

    if (!position && dirPrev === -1 && dirNow === 1) {
      const line = last(st.value);
      return {
        action: 'ENTER_LONG',
        ...(line !== null ? { stop: line } : {}),
        reason: 'Supertrend flipped bullish',
      };
    }
    if (position && dirPrev === 1 && dirNow === -1) {
      return { action: 'EXIT', reason: 'Supertrend flipped bearish' };
    }
    return HOLD;
  },
};

/** MACD crossover. */
const macdStrategy: StrategyDefinition = {
  key: 'macd',
  name: 'MACD crossover',
  description: 'Enters long on a bullish MACD/signal crossover, exits on the bearish crossover.',
  params: {
    fast: { label: 'Fast EMA', default: 12, min: 2, max: 50 },
    slow: { label: 'Slow EMA', default: 26, min: 5, max: 100 },
    signal: { label: 'Signal EMA', default: 9, min: 2, max: 50 },
    atrMultiple: { label: 'ATR stop multiple', default: 2.5, min: 0.5, max: 10 },
  },
  build: (p) => (candles, index, position) => {
    const fast = Math.round(p['fast'] ?? 12);
    const slow = Math.round(p['slow'] ?? 26);
    const signalP = Math.round(p['signal'] ?? 9);
    const atrMult = p['atrMultiple'] ?? 2.5;
    if (index < slow + signalP + 2) return HOLD;

    const window = candles.slice(0, index + 1);
    const m = macd(window.map((c) => c.close), fast, slow, signalP);
    const mNow = last(m.macd);
    const mPrev = at(m.macd, 1);
    const sNow = last(m.signal);
    const sPrev = at(m.signal, 1);
    if (mNow === null || mPrev === null || sNow === null || sPrev === null) return HOLD;

    if (!position && mPrev <= sPrev && mNow > sNow) {
      const a = last(atr(window, 14));
      const price = window.at(-1)!.close;
      return {
        action: 'ENTER_LONG',
        ...(a !== null ? { stop: price - a * atrMult } : {}),
        reason: 'MACD crossed above its signal line',
      };
    }
    if (position && mPrev >= sPrev && mNow < sNow) {
      return { action: 'EXIT', reason: 'MACD crossed below its signal line' };
    }
    return HOLD;
  },
};

/** VWAP reversion — intraday only, since VWAP resets each session. */
const vwapStrategy: StrategyDefinition = {
  key: 'vwap',
  name: 'VWAP reclaim (intraday)',
  description:
    'Intraday only. Enters long when price reclaims session VWAP from below, exits when it loses VWAP. Meaningless on daily or higher bars, where VWAP does not reset.',
  params: {
    atrMultiple: { label: 'ATR stop multiple', default: 1.5, min: 0.5, max: 10 },
  },
  build: (p) => (candles, index, position) => {
    const atrMult = p['atrMultiple'] ?? 1.5;
    if (index < 20) return HOLD;

    const window = candles.slice(0, index + 1);
    const v = vwap(window, (c) => toIst(new Date(c.ts)).dateKey);
    const vNow = last(v);
    const vPrev = at(v, 1);
    if (vNow === null || vPrev === null) return HOLD;

    const bar = window.at(-1)!;
    const prevBar = window.at(-2)!;

    if (!position && prevBar.close <= vPrev && bar.close > vNow) {
      const a = last(atr(window, 14));
      return {
        action: 'ENTER_LONG',
        ...(a !== null ? { stop: bar.close - a * atrMult } : {}),
        reason: `Price reclaimed session VWAP at ${vNow.toFixed(2)}`,
      };
    }
    if (position && bar.close < vNow) {
      return { action: 'EXIT', reason: `Price lost session VWAP at ${vNow.toFixed(2)}` };
    }
    return HOLD;
  },
};

export const STRATEGIES: Record<string, StrategyDefinition> = {
  [emaCrossover.key]: emaCrossover,
  [rsiStrategy.key]: rsiStrategy,
  [breakoutStrategy.key]: breakoutStrategy,
  [supertrendStrategy.key]: supertrendStrategy,
  [macdStrategy.key]: macdStrategy,
  [vwapStrategy.key]: vwapStrategy,
};

export function buildStrategy(
  key: string,
  params: Record<string, number> = {},
): Strategy | null {
  const def = STRATEGIES[key];
  if (!def) return null;

  const merged: Record<string, number> = {};
  for (const [k, spec] of Object.entries(def.params)) {
    const supplied = params[k];
    merged[k] =
      typeof supplied === 'number' && Number.isFinite(supplied)
        ? Math.min(spec.max, Math.max(spec.min, supplied))
        : spec.default;
  }
  return def.build(merged);
}

export function listStrategies(): Array<{
  key: string;
  name: string;
  description: string;
  params: StrategyDefinition['params'];
}> {
  return Object.values(STRATEGIES).map((s) => ({
    key: s.key,
    name: s.name,
    description: s.description,
    params: s.params,
  }));
}

/** Suppress the unused-import warning for `Candle` while keeping the type export. */
export type { Candle };
