/**
 * Position advisor — watches open trades and says what it would do.
 *
 * Every judgement here is a comparison between two measured numbers: the
 * current premium against the level recorded at entry, the days remaining
 * against the days assumed, the rule score now against the one that
 * justified the trade. Nothing is predicted.
 *
 * The advice is phrased as a recommendation because that is what the user
 * asked for, but the reasoning is always shown alongside it, and the numbers
 * in the reasoning come from the chain and the ledger — never from a model
 * and never from a guess. Where a fact cannot be obtained, the advisor says
 * the position cannot be assessed rather than assessing it anyway.
 */
import { queryRows, queryOne } from '../../db/pool.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, getCandles } from '../market/marketData.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { calculateRoundTripCosts } from '../../analysis/backtest/costs.js';
import { underlyingInstrumentFor } from '../options/options.service.js';
import type { PaperTradeRow } from './paper.service.js';

export type AdviceAction = 'CLOSE' | 'CONSIDER_CLOSING' | 'WATCH' | 'HOLD' | 'CANNOT_ASSESS';

/** Ordered worst-first, so the most urgent advice wins when several apply. */
const SEVERITY: Record<AdviceAction, number> = {
  CLOSE: 0, CONSIDER_CLOSING: 1, WATCH: 2, HOLD: 3, CANNOT_ASSESS: 4,
};

export interface PositionAdvice {
  tradeId: string;
  tradingsymbol: string;
  underlying: string | null;
  action: AdviceAction;
  /** One line, in plain words. */
  headline: string;
  /** The observations behind it, each a measured number. */
  reasons: string[];
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  /** Mark-to-market, net of the round-trip cost stack. */
  unrealizedNet: number | null;
  unrealizedPct: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  /** Fraction of the way from entry to target, 0–1+. */
  progressToTarget: number | null;
  /** Fraction of the way from entry to stop, 0–1+. */
  progressToStop: number | null;
  /** Reward already banked divided by the risk still on the table. */
  realizedRewardRisk: number | null;
  daysToExpiry: number | null;
  /** Whether the rule score still supports the direction taken at entry. */
  thesisIntact: boolean | null;
}

const num = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/**
 * Close when this much of the move to target has been captured.
 *
 * Not 100%: options rarely travel the last stretch cleanly, and a position
 * that round-trips from +80% back to the stop is the most common way a
 * winning idea becomes a loss.
 */
const TAKE_PROFIT_AT = 0.8;

/** Warn once the underlying has covered this much of the distance to the stop. */
const STOP_PROXIMITY_WARN = 0.7;

/** Below this many days, theta dominates whatever the chart is doing. */
const THETA_DANGER_DAYS = 2;

export async function adviseOnOpenPositions(userId: string): Promise<PositionAdvice[]> {
  const open = await queryRows<PaperTradeRow>(
    `SELECT * FROM paper_trades WHERE user_id = $1 AND status = 'OPEN' ORDER BY entry_at`,
    [userId],
  );
  if (open.length === 0) return [];

  const registry = await registryForUser(userId);
  const out: PositionAdvice[] = [];

  for (const trade of open) {
    out.push(await adviseOne(registry, trade));
  }

  return out.sort((a, b) => SEVERITY[a.action] - SEVERITY[b.action]);
}

async function adviseOne(
  registry: Awaited<ReturnType<typeof registryForUser>>,
  trade: PaperTradeRow,
): Promise<PositionAdvice> {
  const entry = Number(trade.entry_price);
  const stop = num(trade.stop_price);
  const target = num(trade.target_price);
  const underlyingStop = num(trade.underlying_stop);

  const base: PositionAdvice = {
    tradeId: trade.id,
    tradingsymbol: trade.tradingsymbol,
    underlying: trade.underlying,
    action: 'CANNOT_ASSESS',
    headline: '',
    reasons: [],
    quantity: trade.quantity,
    entryPrice: entry,
    currentPrice: null,
    unrealizedNet: null,
    unrealizedPct: null,
    stopPrice: stop,
    targetPrice: target,
    progressToTarget: null,
    progressToStop: null,
    realizedRewardRisk: null,
    daysToExpiry: null,
    thesisIntact: null,
  };

  if (trade.instrument_id === null) {
    return { ...base, headline: 'This position has no instrument attached, so it cannot be priced.' };
  }
  const instrument = await instrumentsRepo.getById(trade.instrument_id);
  if (!instrument) {
    return { ...base, headline: 'The contract is no longer in the instrument master.' };
  }

  const quote = await getQuote(registry, instrument);
  if (!isAvailable(quote)) {
    return {
      ...base,
      headline: 'No current price for this contract, so it cannot be assessed right now.',
      reasons: [quote.detail ?? 'quote unavailable'],
    };
  }

  const current = quote.value.ltp;
  const reasons: string[] = [];

  // Mark to market, net of what it costs to get in and out.
  const costs = calculateRoundTripCosts(entry, current, trade.quantity, 'OPT', 'LONG');
  const gross = (current - entry) * trade.quantity;
  const net = gross - costs.total;
  const pct = ((current - entry) / entry) * 100;

  reasons.push(
    `Premium ₹${entry.toFixed(2)} → ₹${current.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%), ` +
    `₹${net.toFixed(0)} net of ₹${costs.total.toFixed(0)} round-trip costs.`,
  );

  const progressToTarget =
    target !== null && target > entry ? (current - entry) / (target - entry) : null;
  const progressToStop =
    stop !== null && stop < entry ? (entry - current) / (entry - stop) : null;

  // Days to expiry, from the contract itself.
  let daysToExpiry: number | null = null;
  if (instrument.expiry) {
    const ms = new Date(instrument.expiry).getTime() - Date.now();
    daysToExpiry = Math.max(0, Math.ceil(ms / 864e5));
  }

  // Is the reason for the trade still true?
  let thesisIntact: boolean | null = null;
  if (trade.underlying) {
    try {
      const spot = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(trade.underlying));
      if (spot) {
        const candles = await getCandles(registry, spot, '1d', { bars: 300 });
        if (candles.candles.length >= 30) {
          const report = runSignalEngine(buildSnapshot(spot.tradingsymbol, '1d', candles.candles));
          const score = report.overallScore;
          if (score !== null) {
            // The entry was a long call or long put; either way the position
            // needs the underlying to keep going the way it was going.
            const wantedBullish = trade.tradingsymbol.endsWith('CE');
            thesisIntact = wantedBullish ? score >= 50 : score <= 50;
            reasons.push(
              `Underlying rule score is now ${score.toFixed(0)}/100, which ` +
              `${thesisIntact ? 'still supports' : 'no longer supports'} the direction this trade was taken on.`,
            );
          }
        }
      }
    } catch {
      // A missing score is not a reason to withhold the rest of the advice.
    }
  }

  // ── the decision ─────────────────────────────────────────────────────────
  // Ordered by urgency: capital preservation before profit-taking, and both
  // before anything about the chart.

  let action: AdviceAction = 'HOLD';
  let headline = 'Nothing has changed enough to act on.';

  if (stop !== null && current <= stop) {
    action = 'CLOSE';
    headline = `Stop hit. Close this — the premium is at or below the ₹${stop.toFixed(2)} invalidation you set at entry.`;
  } else if (target !== null && current >= target) {
    action = 'CLOSE';
    headline = `Target reached at ₹${current.toFixed(2)}. Take the ₹${net.toFixed(0)}.`;
  } else if (daysToExpiry !== null && daysToExpiry <= THETA_DANGER_DAYS) {
    action = net > 0 ? 'CLOSE' : 'CONSIDER_CLOSING';
    headline =
      `${daysToExpiry} day(s) to expiry. Time decay now dominates direction — ` +
      (net > 0 ? 'bank it.' : 'closing limits the loss to what is left.');
    reasons.push('An option held to expiry out of the money is worth nothing, regardless of the chart.');
  } else if (progressToTarget !== null && progressToTarget >= TAKE_PROFIT_AT) {
    action = 'CONSIDER_CLOSING';
    headline =
      `${(progressToTarget * 100).toFixed(0)}% of the way to target with ₹${net.toFixed(0)} on the table. ` +
      'Worth taking rather than holding for the last stretch.';
    reasons.push(
      'The last part of a move is the least reliable; a position that gives back a large gain ' +
      'is the commonest way a correct call ends up a loss.',
    );
  } else if (thesisIntact === false) {
    action = 'CONSIDER_CLOSING';
    headline =
      'The reason for this trade no longer holds — the underlying score has crossed against it.';
  } else if (progressToStop !== null && progressToStop >= STOP_PROXIMITY_WARN) {
    action = 'WATCH';
    headline =
      `${(progressToStop * 100).toFixed(0)}% of the way to the stop. ` +
      'Still inside the plan, but close to the level that invalidates it.';
  } else if (underlyingStop !== null) {
    headline = `Holding. The plan is intact until the underlying trades through ${underlyingStop.toFixed(0)}.`;
  }

  if (daysToExpiry !== null) reasons.push(`${daysToExpiry} day(s) to expiry.`);

  // Reward banked against the risk still exposed, when both are knowable.
  const realizedRewardRisk =
    stop !== null && current > entry && entry > stop
      ? (current - entry) / (entry - stop)
      : null;
  if (realizedRewardRisk !== null) {
    reasons.push(
      `Captured ${realizedRewardRisk.toFixed(2)}× the amount still at risk to the stop.`,
    );
  }

  return {
    ...base,
    action,
    headline,
    reasons,
    currentPrice: current,
    unrealizedNet: Number(net.toFixed(2)),
    unrealizedPct: Number(pct.toFixed(2)),
    progressToTarget,
    progressToStop,
    realizedRewardRisk,
    daysToExpiry,
    thesisIntact,
  };
}

/** Advice worth interrupting someone for. */
export const isActionable = (a: PositionAdvice): boolean =>
  a.action === 'CLOSE' || a.action === 'CONSIDER_CLOSING';

/** The most urgent open position, for a one-line notification. */
export async function mostUrgentAdvice(userId: string): Promise<PositionAdvice | null> {
  const all = await adviseOnOpenPositions(userId);
  const actionable = all.filter(isActionable);
  return actionable[0] ?? null;
}

/** Whether a user has any open paper position at all. */
export async function hasOpenPositions(userId: string): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM paper_trades WHERE user_id = $1 AND status = 'OPEN'`,
    [userId],
  );
  return Number(row?.n ?? 0) > 0;
}
