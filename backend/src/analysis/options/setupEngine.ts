/**
 * F&O setup engine — turns a directional read on the underlying plus a live
 * option chain into one concrete, fully-priced option trade.
 *
 * What this is
 * ------------
 * A deterministic rule engine. Given the same inputs it returns the same
 * output, and every number it reports is either read from the chain or
 * computed here from numbers that were. There is no model, no training, and
 * no probability estimate anywhere in it.
 *
 * What this is not
 * ----------------
 * It is not a prediction, and a high `confirmation` score does not mean a
 * high chance of profit. `confirmation` counts how many independent
 * conditions currently agree — nothing more. Options lose value to theta
 * every day the underlying fails to move, so even a correct directional read
 * can lose money. The engine therefore always states the invalidation level
 * and the full premium at risk, and refuses to produce a trade when the
 * evidence does not line up.
 *
 * Capital is never inferred. The caller passes it, because how much of their
 * own money a person puts at risk is not a decision this code should make.
 */
import type { NormalizedOptionChain, OptionStrike } from '../../providers/types.js';
import type { SignalReport } from '../signals/engine.js';
import {
  calculatePcr,
  calculateMaxPain,
  deriveOiLevels,
  computeChainGreeks,
  type PcrResult,
  type MaxPainResult,
  type OiLevels,
} from './analytics.js';
import { calculatePositionSize, type PositionSizeResult } from '../risk/positionSizing.js';

export type OptionAction = 'BUY_CALL' | 'BUY_PUT' | 'NO_TRADE';
export type Bias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface OptionSetupInput {
  underlying: string;
  chain: NormalizedOptionChain;
  /** Rule-engine report for the underlying instrument. */
  signal: SignalReport;
  /** ATR of the underlying on the signal timeframe, for the invalidation level. */
  atr: number | null;
  /** Trading capital, in rupees. Supplied by the user — never assumed. */
  capital: number;
  /** Percent of capital the user accepts losing on this trade. */
  riskPercent: number;
  /** Multiple of ATR for the underlying's invalidation level. */
  atrStopMultiple?: number;
  /** Reward-to-risk the target must clear for the trade to be reported. */
  minRewardRisk?: number;
  now?: Date;
}

export interface EvidenceItem {
  label: string;
  value: string;
  /** Where the number came from, so nothing reads as an assertion. */
  source: 'chain' | 'signal_engine' | 'calculated' | 'user_input';
}

export interface OptionSetup {
  action: OptionAction;
  underlying: string;
  expiry: string;
  bias: Bias;
  /** 0–100 count of agreeing conditions. NOT a probability of profit. */
  confirmation: number;
  strike: number | null;
  optionType: 'CE' | 'PE' | null;
  /** Premium per unit at entry. */
  entryPremium: number | null;
  /** Premium at which the underlying thesis is proven wrong. */
  stopPremium: number | null;
  targetPremium: number | null;
  /** The level on the UNDERLYING that invalidates the trade. */
  underlyingStop: number | null;
  underlyingTarget: number | null;
  spot: number | null;
  lotSize: number | null;
  delta: number | null;
  rewardRisk: number | null;
  sizing: PositionSizeResult | null;
  /** Total premium outlay — the entire amount that can be lost. */
  totalPremiumAtRisk: number | null;
  evidence: EvidenceItem[];
  /** Conditions that argue against the trade. Never hidden. */
  warnings: string[];
  /** Why no trade, when action is NO_TRADE. */
  rejectedBecause: string[];
  interpretation: string;
}

const BULLISH_ABOVE = 60;
const BEARISH_BELOW = 40;

/** Round to the chain's own strike spacing rather than assuming 50 or 100. */
function strikeStep(strikes: readonly OptionStrike[]): number | null {
  if (strikes.length < 2) return null;
  const sorted = [...strikes].map((s) => s.strike).sort((a, b) => a - b);
  const gaps = new Map<number, number>();
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = Math.round((sorted[i]! - sorted[i - 1]!) * 100) / 100;
    if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [gap, count] of gaps) {
    if (count > bestCount) { best = gap; bestCount = count; }
  }
  return best;
}

const mid = (bid: number | null, ask: number | null): number | null =>
  bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid ? (bid + ask) / 2 : null;

/**
 * Entry price for a leg.
 *
 * Mid of the book when both sides are quoted, because LTP on an illiquid
 * strike can be minutes stale and far from where you would actually fill.
 * Falls back to LTP when there is no book.
 */
function legEntry(leg: { ltp: number | null; bid: number | null; ask: number | null }): number | null {
  return mid(leg.bid, leg.ask) ?? (leg.ltp !== null && leg.ltp > 0 ? leg.ltp : null);
}

export function buildOptionSetup(input: OptionSetupInput): OptionSetup {
  const {
    underlying, chain, signal, atr, capital, riskPercent,
    atrStopMultiple = 1.5, minRewardRisk = 1.5, now = new Date(),
  } = input;

  const evidence: EvidenceItem[] = [];
  const warnings: string[] = [];
  const rejected: string[] = [];

  const spot = chain.spot;
  const pcr = calculatePcr(chain);
  const maxPain = calculateMaxPain(chain);
  const oiLevels = deriveOiLevels(chain);

  const base = (over: Partial<OptionSetup> = {}): OptionSetup => ({
    action: 'NO_TRADE', underlying, expiry: chain.expiry, bias: 'NEUTRAL',
    confirmation: 0, strike: null, optionType: null, entryPremium: null,
    stopPremium: null, targetPremium: null, underlyingStop: null,
    underlyingTarget: null, spot, lotSize: chain.lotSize, delta: null,
    rewardRisk: null, sizing: null, totalPremiumAtRisk: null,
    evidence, warnings, rejectedBecause: rejected,
    interpretation: '', ...over,
  });

  // ── inputs that must exist ────────────────────────────────────────────────
  if (spot === null || spot <= 0) {
    rejected.push('The chain carries no spot price for the underlying, so no strike can be chosen.');
    return base({ interpretation: 'No trade: the underlying is not priced.' });
  }
  if (capital <= 0) {
    rejected.push('Trading capital must be entered before a position can be sized.');
    return base({ interpretation: 'No trade: enter your capital.' });
  }
  if (signal.overallScore === null) {
    rejected.push('The rule engine could not score the underlying — not enough price history.');
    return base({ interpretation: 'No trade: the underlying has no directional score.' });
  }

  evidence.push(
    { label: 'Spot', value: spot.toFixed(2), source: 'chain' },
    { label: 'Directional score', value: `${signal.overallScore.toFixed(0)}/100`, source: 'signal_engine' },
    { label: 'Capital', value: `₹${capital.toFixed(0)}`, source: 'user_input' },
    { label: 'Risk per trade', value: `${riskPercent}%`, source: 'user_input' },
  );

  // ── 1. direction, from the underlying only ────────────────────────────────
  const score = signal.overallScore;
  const bias: Bias = score >= BULLISH_ABOVE ? 'BULLISH' : score <= BEARISH_BELOW ? 'BEARISH' : 'NEUTRAL';

  if (bias === 'NEUTRAL') {
    rejected.push(
      `The directional score is ${score.toFixed(0)}, inside the ${BEARISH_BELOW}–${BULLISH_ABOVE} ` +
      'band where the rules do not agree on a direction. Buying an option here pays theta for a view nobody holds.',
    );
    return base({ bias, interpretation: 'No trade: no directional edge in the rules.' });
  }

  // ── 2. does the chain agree? ──────────────────────────────────────────────
  let confirmation = 40; // a directional score alone is one condition, not many
  const agree: string[] = [];

  if (pcr.pcrOi !== null) {
    evidence.push({ label: 'PCR (OI)', value: pcr.pcrOi.toFixed(2), source: 'chain' });
    // High PCR = more puts open than calls; conventionally read as supportive
    // of the upside, and vice versa. A reading, not a forecast.
    const pcrBull = pcr.pcrOi >= 1.0;
    if ((bias === 'BULLISH') === pcrBull) { confirmation += 15; agree.push(`PCR ${pcr.pcrOi.toFixed(2)}`); }
    else warnings.push(`PCR of ${pcr.pcrOi.toFixed(2)} reads against the ${bias.toLowerCase()} view.`);
  }

  if (maxPain.maxPain !== null) {
    evidence.push({ label: 'Max pain', value: maxPain.maxPain.toFixed(0), source: 'chain' });
    const painAbove = maxPain.maxPain > spot;
    if ((bias === 'BULLISH') === painAbove) { confirmation += 10; agree.push(`max pain ${maxPain.maxPain.toFixed(0)}`); }
    else warnings.push(`Max pain at ${maxPain.maxPain.toFixed(0)} sits on the far side of spot from this trade.`);
  }

  const wall = bias === 'BULLISH' ? oiLevels.resistances[0] : oiLevels.supports[0];
  if (wall) {
    evidence.push({
      label: bias === 'BULLISH' ? 'Nearest call OI wall' : 'Nearest put OI wall',
      value: String(wall.strike), source: 'chain',
    });
    const distancePct = Math.abs(wall.strike - spot) / spot * 100;
    if (distancePct < 0.5) {
      warnings.push(
        `A large OI wall sits at ${wall.strike}, only ${distancePct.toFixed(2)}% away — ` +
        'that is often where the move stalls.',
      );
    } else confirmation += 10;
  }

  // ── 3. pick the strike ────────────────────────────────────────────────────
  const step = strikeStep(chain.strikes);
  if (step === null) {
    rejected.push('The chain has too few strikes to determine its spacing.');
    return base({ bias, interpretation: 'No trade: unusable strike ladder.' });
  }
  evidence.push({ label: 'Strike spacing', value: String(step), source: 'chain' });

  const atmStrike = Math.round(spot / step) * step;
  // One step out of the money: cheaper than ATM, still the most liquid strike
  // after it, and less theta-exposed than deep OTM lottery tickets.
  const wanted = bias === 'BULLISH' ? atmStrike + step : atmStrike - step;
  const optionType = bias === 'BULLISH' ? 'CE' : 'PE';

  const row = chain.strikes.find((s) => Math.abs(s.strike - wanted) < step / 2)
    ?? chain.strikes.find((s) => Math.abs(s.strike - atmStrike) < step / 2);
  const leg = row ? (optionType === 'CE' ? row.call : row.put) : null;

  if (!row || !leg) {
    rejected.push(`No ${optionType} contract is listed near ${wanted}.`);
    return base({ bias, interpretation: 'No trade: the wanted strike is not listed.' });
  }

  const entryPremium = legEntry(leg);
  if (entryPremium === null || entryPremium <= 0) {
    rejected.push(`The ${row.strike} ${optionType} has no usable price — no book and no last trade.`);
    return base({ bias, strike: row.strike, optionType, interpretation: 'No trade: the strike is not priced.' });
  }

  evidence.push({
    label: 'Entry premium',
    value: `₹${entryPremium.toFixed(2)}` + (mid(leg.bid, leg.ask) !== null ? ' (bid/ask mid)' : ' (last traded)'),
    source: 'chain',
  });

  // Liquidity is the difference between a paper setup and a fillable one.
  if (leg.oi !== null && leg.oi > 0) {
    evidence.push({ label: 'Open interest', value: leg.oi.toLocaleString('en-IN'), source: 'chain' });
  } else warnings.push('This strike shows no open interest — exiting may be difficult.');

  // A closed market quotes 0/0. Treating that as a 0% spread scored an
  // unquoted strike as perfectly liquid — exactly backwards.
  const hasBook = leg.bid !== null && leg.ask !== null && leg.bid > 0 && leg.ask > 0;
  const spread = hasBook ? leg.ask! - leg.bid! : null;
  if (!hasBook) {
    warnings.push('No two-sided quote for this strike right now, so the fill price is unknown.');
  }
  if (spread !== null && entryPremium > 0) {
    const spreadPct = (spread / entryPremium) * 100;
    evidence.push({ label: 'Bid-ask spread', value: `${spreadPct.toFixed(1)}% of premium`, source: 'calculated' });
    if (spreadPct > 5) {
      warnings.push(`The spread is ${spreadPct.toFixed(1)}% of the premium — that cost is paid on entry and exit.`);
      confirmation -= 10;
    } else confirmation += 10;
  }

  // ── 4. invalidation and target, on the underlying ─────────────────────────
  if (atr === null || atr <= 0) {
    rejected.push('No ATR for the underlying, so there is no non-arbitrary invalidation level.');
    return base({ bias, strike: row.strike, optionType, entryPremium, interpretation: 'No trade: cannot place a stop.' });
  }
  evidence.push({ label: 'ATR (underlying)', value: atr.toFixed(2), source: 'signal_engine' });

  const stopDistance = atr * atrStopMultiple;
  const underlyingStop = bias === 'BULLISH' ? spot - stopDistance : spot + stopDistance;
  const underlyingTarget = bias === 'BULLISH' ? spot + stopDistance * minRewardRisk : spot - stopDistance * minRewardRisk;

  // ── 5. map those levels onto the premium, via delta ───────────────────────
  const greeks = computeChainGreeks(chain, { now });
  const strikeGreeks = greeks.strikes.find((g) => g.strike === row.strike);
  const delta = optionType === 'CE' ? strikeGreeks?.call?.delta ?? null : strikeGreeks?.put?.delta ?? null;

  if (delta === null || delta === 0) {
    rejected.push('Delta could not be solved for this strike, so the stop cannot be expressed as a premium.');
    return base({ bias, strike: row.strike, optionType, entryPremium, underlyingStop, underlyingTarget,
      interpretation: 'No trade: cannot translate the stop into a premium.' });
  }
  evidence.push({ label: 'Delta', value: delta.toFixed(3), source: 'calculated' });

  // Delta is a first-order, instantaneous sensitivity. Over a move this size
  // it understates gains and overstates losses (gamma), and it ignores theta
  // and IV entirely. Good enough to size a position; not a price forecast.
  const premiumMovePerPoint = Math.abs(delta);
  const impliedLoss = stopDistance * premiumMovePerPoint;
  // If the adverse move costs more than the premium itself, the option is
  // worthless before the underlying ever reaches the stop. Flooring the number
  // and moving on would print a "stop" of ₹0.05 that can never be acted on,
  // and understate the risk as a stop distance rather than the whole outlay.
  const stopUnreachable = impliedLoss >= entryPremium * 0.9;
  const stopPremium = Math.max(0.05, entryPremium - impliedLoss);
  if (stopUnreachable) {
    warnings.push(
      `A ${stopDistance.toFixed(0)}-point adverse move costs about ₹${impliedLoss.toFixed(2)} of a ` +
      `₹${entryPremium.toFixed(2)} premium at delta ${delta.toFixed(2)}, so this option is close to ` +
      'worthless before the underlying stop is reached. Treat the entire premium as the risk — ' +
      'the stop price shown is nominal and cannot be relied on.',
    );
  }
  const targetPremium = entryPremium + stopDistance * minRewardRisk * premiumMovePerPoint;

  const riskPerUnit = entryPremium - stopPremium;
  const rewardRisk = riskPerUnit > 0 ? (targetPremium - entryPremium) / riskPerUnit : null;
  if (rewardRisk !== null) {
    evidence.push({ label: 'Reward:risk', value: `${rewardRisk.toFixed(2)}:1`, source: 'calculated' });
  }

  // ── 6. size it, from the capital the user typed ───────────────────────────
  const lotSize = chain.lotSize ?? 1;
  let sizing: PositionSizeResult | null = null;
  try {
    sizing = calculatePositionSize({
      entry: entryPremium,
      stop: stopPremium,
      config: {
        capital,
        maxRiskPerTradePct: riskPercent,
        // Not consulted by calculatePositionSize; present to satisfy RiskConfig.
        maxDailyLossPct: riskPercent * 3,
        maxOpenPositions: 5,
      },
      lotSize,
      wholeLotsOnly: true,
    });
  } catch (err) {
    rejected.push(`Position sizing failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }

  if (!sizing || sizing.quantity <= 0) {
    rejected.push(
      `₹${capital.toFixed(0)} at ${riskPercent}% risk does not cover one lot of ${lotSize} ` +
      `at a ₹${riskPerUnit.toFixed(2)} stop (₹${(riskPerUnit * lotSize).toFixed(0)} per lot). ` +
      'Increase capital, widen risk, or choose a cheaper strike.',
    );
    return base({
      bias, strike: row.strike, optionType, entryPremium, stopPremium, targetPremium,
      underlyingStop, underlyingTarget, delta, rewardRisk, sizing,
      interpretation: 'No trade: one lot exceeds the risk budget.',
    });
  }

  // Buying an option risks the whole premium, not just the stop distance —
  // a gap can skip the stop entirely. Report the real worst case.
  const totalPremiumAtRisk = entryPremium * sizing.quantity;
  evidence.push(
    { label: 'Lots', value: `${sizing.lots} × ${lotSize}`, source: 'calculated' },
    { label: 'Premium outlay', value: `₹${totalPremiumAtRisk.toFixed(0)}`, source: 'calculated' },
    { label: 'Risk at stop', value: `₹${sizing.actualCapitalAtRisk.toFixed(0)}`, source: 'calculated' },
  );

  if (totalPremiumAtRisk > capital * 0.25) {
    warnings.push(
      `The premium outlay is ${((totalPremiumAtRisk / capital) * 100).toFixed(0)}% of capital. ` +
      'A gap through the stop loses all of it.',
    );
  }

  // ── 7. only then, a trade ─────────────────────────────────────────────────
  // The target is placed at exactly minRewardRisk × the stop distance, so
  // whenever the stop is reachable the ratio equals the floor by construction
  // and only floating-point noise decides which side of it lands. Without the
  // tolerance, 1.4999999999999998 rejected trades that 1.5000000000000002 let
  // through — a coin flip on the last bit of a double.
  const RR_TOLERANCE = 1e-9;
  if (rewardRisk !== null && rewardRisk < minRewardRisk - RR_TOLERANCE) {
    rejected.push(`Reward:risk of ${rewardRisk.toFixed(2)}:1 is below the ${minRewardRisk}:1 floor.`);
    return base({
      bias, strike: row.strike, optionType, entryPremium, stopPremium, targetPremium,
      underlyingStop, underlyingTarget, delta, rewardRisk, sizing, totalPremiumAtRisk,
      interpretation: 'No trade: the payoff does not justify the risk.',
    });
  }

  confirmation = Math.max(0, Math.min(100, confirmation));

  return base({
    action: optionType === 'CE' ? 'BUY_CALL' : 'BUY_PUT',
    bias,
    confirmation,
    strike: row.strike,
    optionType,
    entryPremium,
    stopPremium,
    targetPremium,
    underlyingStop,
    underlyingTarget,
    delta,
    rewardRisk,
    sizing,
    totalPremiumAtRisk,
    interpretation:
      `${confirmation} of 100 conditions agree on a ${bias.toLowerCase()} view: ` +
      `${agree.join(', ') || 'the underlying rule score alone'}. ` +
      `Buy ${sizing.lots} lot(s) of ${underlying} ${row.strike} ${optionType} near ₹${entryPremium.toFixed(2)}; ` +
      `exit if ${underlying} trades through ${underlyingStop.toFixed(0)}. ` +
      `This counts agreeing conditions — it is not a probability of profit, and the full ` +
      `₹${totalPremiumAtRisk.toFixed(0)} premium can be lost.`,
  });
}

export type { PcrResult, MaxPainResult, OiLevels };
