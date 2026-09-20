/**
 * Backtest engine.
 *
 * Design choices that keep results honest:
 *  · **Next-bar execution.** A signal computed on bar i fills at bar i+1's
 *    open. Filling at the close of the bar that produced the signal is
 *    lookahead bias and is the most common way a backtest lies.
 *  · **Indicators computed on a prefix.** At bar i the engine passes only
 *    bars 0..i to the strategy, so no indicator can see the future.
 *  · **Costs and slippage always applied**, using the Indian fee stack.
 *  · **Intrabar stop/target resolution is pessimistic.** If a bar's range
 *    touches both the stop and the target, the stop is assumed to have hit
 *    first, because the engine cannot know the intrabar path.
 *
 * Results are historical simulation, never a forecast, and the report says so.
 */
import type { Candle } from '../indicators/index.js';
import {
  calculateRoundTripCosts, applySlippage, DEFAULT_COSTS,
  type Segment, type CostConfig,
} from './costs.js';

export interface BacktestSignal {
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'EXIT' | 'HOLD';
  /** Absolute stop price for a new position. */
  stop?: number;
  target?: number;
  reason?: string;
}

/**
 * A strategy sees only the bars up to and including `index`.
 * `position` is the currently open position, if any.
 */
export type Strategy = (
  candles: readonly Candle[],
  index: number,
  position: OpenPosition | null,
) => BacktestSignal;

export interface OpenPosition {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  entryIndex: number;
  entryTs: string;
  quantity: number;
  stop: number | null;
  target: number | null;
  /** Worst and best excursion while open, for MAE/MFE reporting. */
  maeAbs: number;
  mfeAbs: number;
}

export interface CompletedTrade {
  direction: 'LONG' | 'SHORT';
  entryTs: string;
  entryPrice: number;
  exitTs: string;
  exitPrice: number;
  quantity: number;
  barsHeld: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  returnPct: number;
  exitReason: 'STOP' | 'TARGET' | 'SIGNAL' | 'END_OF_DATA';
  mae: number;
  mfe: number;
}

export interface BacktestConfig {
  initialCapital: number;
  segment: Segment;
  costConfig?: CostConfig;
  /** Fraction of equity committed per trade, 0–1. */
  positionSizePct: number;
  /** Cap on simultaneous positions. This engine trades one symbol at a time. */
  allowShort: boolean;
  /** Risk-free rate for the Sharpe calculation, annualised decimal. */
  riskFreeRate: number;
  /** Bars per year, for annualisation. 252 for daily. */
  barsPerYear: number;
}

export const DEFAULT_BACKTEST_CONFIG: BacktestConfig = {
  initialCapital: 500000,
  segment: 'EQ_DELIVERY',
  positionSizePct: 0.95,
  allowShort: false,
  riskFreeRate: 0.065,
  barsPerYear: 252,
};

export interface BacktestResult {
  trades: CompletedTrade[];
  equityCurve: Array<{ ts: string; equity: number; drawdownPct: number }>;

  initialCapital: number;
  finalCapital: number;
  totalReturnPct: number;
  cagr: number | null;
  maxDrawdownPct: number;
  maxDrawdownDurationBars: number;

  tradeCount: number;
  winCount: number;
  lossCount: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  largestWin: number | null;
  largestLoss: number | null;
  profitFactor: number | null;
  expectancy: number | null;
  avgBarsHeld: number | null;

  sharpe: number | null;
  sortino: number | null;

  totalCharges: number;
  /** What the strategy would have returned with zero costs. */
  grossReturnPct: number;
  /** How much of the gross return the cost stack consumed. */
  costDragPct: number;

  barsProcessed: number;
  warnings: string[];
  methodology: string;
}

export function runBacktest(
  candles: readonly Candle[],
  strategy: Strategy,
  configInput: Partial<BacktestConfig> = {},
): BacktestResult {
  const config: BacktestConfig = { ...DEFAULT_BACKTEST_CONFIG, ...configInput };
  const warnings: string[] = [];

  if (candles.length < 30) {
    warnings.push(`Only ${candles.length} bars supplied; results over such a short sample are not meaningful.`);
  }

  let equity = config.initialCapital;
  let position: OpenPosition | null = null;
  const trades: CompletedTrade[] = [];
  const equityCurve: Array<{ ts: string; equity: number; drawdownPct: number }> = [];

  let peak = equity;
  let maxDrawdown = 0;
  let drawdownStart = 0;
  let maxDrawdownDuration = 0;
  let totalCharges = 0;
  let grossPnlTotal = 0;

  // Start once there is enough history for typical indicators to be defined.
  const warmup = Math.min(200, Math.floor(candles.length * 0.2));

  for (let i = warmup; i < candles.length; i += 1) {
    const bar = candles[i]!;

    // ── manage an open position against THIS bar's range ──
    if (position) {
      const dir = position.direction;
      const excursionLow = dir === 'LONG' ? bar.low - position.entryPrice : position.entryPrice - bar.high;
      const excursionHigh = dir === 'LONG' ? bar.high - position.entryPrice : position.entryPrice - bar.low;
      position.maeAbs = Math.min(position.maeAbs, excursionLow);
      position.mfeAbs = Math.max(position.mfeAbs, excursionHigh);

      const stopHit =
        position.stop !== null &&
        (dir === 'LONG' ? bar.low <= position.stop : bar.high >= position.stop);
      const targetHit =
        position.target !== null &&
        (dir === 'LONG' ? bar.high >= position.target : bar.low <= position.target);

      // Pessimistic: when both are touched in one bar, assume the stop first.
      if (stopHit) {
        const { trade, netPnl, charges } = closePosition(
          position, position.stop!, bar.ts, i, 'STOP', config,
        );
        trades.push(trade);
        equity += netPnl;
        totalCharges += charges;
        grossPnlTotal += trade.grossPnl;
        position = null;
      } else if (targetHit) {
        const { trade, netPnl, charges } = closePosition(
          position, position.target!, bar.ts, i, 'TARGET', config,
        );
        trades.push(trade);
        equity += netPnl;
        totalCharges += charges;
        grossPnlTotal += trade.grossPnl;
        position = null;
      }
    }

    // ── ask the strategy, using only bars up to i ──
    const signal = strategy(candles, i, position);

    // ── act on the NEXT bar's open (no lookahead) ──
    const nextBar = candles[i + 1];
    if (!nextBar) continue;

    if (position && signal.action === 'EXIT') {
      const exitPrice = applySlippage(
        nextBar.open,
        position.direction === 'LONG' ? 'SELL' : 'BUY',
        config.segment,
        config.costConfig,
      );
      const { trade, netPnl, charges } = closePosition(
        position, exitPrice, nextBar.ts, i + 1, 'SIGNAL', config,
      );
      trades.push(trade);
      equity += netPnl;
      totalCharges += charges;
      grossPnlTotal += trade.grossPnl;
      position = null;
    } else if (!position && (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT')) {
      const direction = signal.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';
      if (direction === 'SHORT' && !config.allowShort) continue;

      const fillPrice = applySlippage(
        nextBar.open,
        direction === 'LONG' ? 'BUY' : 'SELL',
        config.segment,
        config.costConfig,
      );
      const capitalToDeploy = equity * config.positionSizePct;
      const quantity = Math.floor(capitalToDeploy / fillPrice);

      if (quantity <= 0) {
        warnings.push(`Insufficient equity (₹${equity.toFixed(0)}) to open a position at ₹${fillPrice.toFixed(2)} on ${nextBar.ts}.`);
        continue;
      }

      position = {
        direction,
        entryPrice: fillPrice,
        entryIndex: i + 1,
        entryTs: nextBar.ts,
        quantity,
        stop: signal.stop ?? null,
        target: signal.target ?? null,
        maeAbs: 0,
        mfeAbs: 0,
      };
    }

    // ── mark to market ──
    const markToMarket = position
      ? equity +
        (position.direction === 'LONG'
          ? (bar.close - position.entryPrice) * position.quantity
          : (position.entryPrice - bar.close) * position.quantity)
      : equity;

    if (markToMarket > peak) {
      peak = markToMarket;
      drawdownStart = i;
    }
    const dd = peak > 0 ? (peak - markToMarket) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
    maxDrawdownDuration = Math.max(maxDrawdownDuration, i - drawdownStart);

    equityCurve.push({ ts: bar.ts, equity: markToMarket, drawdownPct: dd * 100 });
  }

  // Close anything still open at the last bar.
  if (position) {
    const lastBar = candles.at(-1)!;
    const exitPrice = applySlippage(
      lastBar.close,
      position.direction === 'LONG' ? 'SELL' : 'BUY',
      config.segment,
      config.costConfig,
    );
    const { trade, netPnl, charges } = closePosition(
      position, exitPrice, lastBar.ts, candles.length - 1, 'END_OF_DATA', config,
    );
    trades.push(trade);
    equity += netPnl;
    totalCharges += charges;
    grossPnlTotal += trade.grossPnl;
    warnings.push('A position was still open at the end of the data and was closed at the final close.');
  }

  return summarise(trades, equityCurve, equity, totalCharges, grossPnlTotal, maxDrawdown,
    maxDrawdownDuration, candles.length - warmup, config, warnings);
}

function closePosition(
  position: OpenPosition,
  exitPrice: number,
  exitTs: string,
  exitIndex: number,
  reason: CompletedTrade['exitReason'],
  config: BacktestConfig,
): { trade: CompletedTrade; netPnl: number; charges: number } {
  const grossPnl =
    position.direction === 'LONG'
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

  const costs = calculateRoundTripCosts(
    position.entryPrice, exitPrice, position.quantity,
    config.segment, position.direction, config.costConfig,
  );

  const netPnl = grossPnl - costs.total;
  const invested = position.entryPrice * position.quantity;

  return {
    charges: costs.total,
    netPnl,
    trade: {
      direction: position.direction,
      entryTs: position.entryTs,
      entryPrice: position.entryPrice,
      exitTs,
      exitPrice,
      quantity: position.quantity,
      barsHeld: exitIndex - position.entryIndex,
      grossPnl,
      charges: costs.total,
      netPnl,
      returnPct: invested > 0 ? (netPnl / invested) * 100 : 0,
      exitReason: reason,
      mae: position.maeAbs * position.quantity,
      mfe: position.mfeAbs * position.quantity,
    },
  };
}

function summarise(
  trades: CompletedTrade[],
  equityCurve: BacktestResult['equityCurve'],
  finalCapital: number,
  totalCharges: number,
  grossPnlTotal: number,
  maxDrawdown: number,
  maxDrawdownDuration: number,
  barsProcessed: number,
  config: BacktestConfig,
  warnings: string[],
): BacktestResult {
  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);

  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  const totalReturnPct =
    ((finalCapital - config.initialCapital) / config.initialCapital) * 100;

  const years = barsProcessed / config.barsPerYear;
  const cagr =
    years > 0 && config.initialCapital > 0 && finalCapital > 0
      ? ((finalCapital / config.initialCapital) ** (1 / years) - 1) * 100
      : null;

  // Per-bar returns from the equity curve, for Sharpe and Sortino.
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i += 1) {
    const prev = equityCurve[i - 1]!.equity;
    if (prev > 0) returns.push(equityCurve[i]!.equity / prev - 1);
  }

  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (returns.length > 20) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
    const vol = Math.sqrt(variance) * Math.sqrt(config.barsPerYear);
    const annualReturn = (1 + mean) ** config.barsPerYear - 1;
    if (vol > 0) sharpe = (annualReturn - config.riskFreeRate) / vol;

    const downside = returns.filter((r) => r < 0);
    if (downside.length > 0) {
      const dd = Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) *
        Math.sqrt(config.barsPerYear);
      if (dd > 0) sortino = (annualReturn - config.riskFreeRate) / dd;
    }
  } else {
    warnings.push('Fewer than 20 equity observations — Sharpe and Sortino are not reported.');
  }

  if (trades.length < 30) {
    warnings.push(
      `Only ${trades.length} trades. Win rate, profit factor and expectancy computed on a sample this small are dominated by noise.`,
    );
  }

  const grossReturnPct = (grossPnlTotal / config.initialCapital) * 100;

  return {
    trades,
    equityCurve,
    initialCapital: config.initialCapital,
    finalCapital,
    totalReturnPct,
    cagr,
    maxDrawdownPct: maxDrawdown * 100,
    maxDrawdownDurationBars: maxDrawdownDuration,
    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : null,
    avgWin: wins.length > 0 ? grossProfit / wins.length : null,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
    largestWin: wins.length > 0 ? Math.max(...wins.map((t) => t.netPnl)) : null,
    largestLoss: losses.length > 0 ? Math.min(...losses.map((t) => t.netPnl)) : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    expectancy: trades.length > 0 ? trades.reduce((s, t) => s + t.netPnl, 0) / trades.length : null,
    avgBarsHeld: trades.length > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : null,
    sharpe,
    sortino,
    totalCharges,
    grossReturnPct,
    costDragPct: grossReturnPct - totalReturnPct,
    barsProcessed,
    warnings,
    methodology:
      'Signals are computed on bars up to and including the current bar, and orders fill at the NEXT bar’s open with slippage applied against the trade. ' +
      'Stops and targets are checked against each bar’s high/low; when a single bar touches both, the stop is assumed to have hit first. ' +
      'Indian transaction costs (brokerage, STT, exchange charges, SEBI fee, GST, stamp duty) are deducted on both legs of every trade. ' +
      'These are HISTORICAL SIMULATION results on past data. They are not a prediction, and live trading differs through execution quality, liquidity, gaps, and the fact that a strategy selected because it performed well on this sample is likely to perform worse on new data.',
  };
}
