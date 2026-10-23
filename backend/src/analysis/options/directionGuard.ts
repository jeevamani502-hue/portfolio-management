/**
 * Direction guard — closes a long option when the chart stops agreeing with it.
 *
 * The plan's stop is a price; this is the reason behind the price. A call
 * bought because the hourly trend was up should not be held while the trend
 * is down, waiting for the premium to bleed to the stop. Every check reads
 * the same charts the entry read and asks whether they still point the
 * same way. Counts, not predictions: the guard says how many readings have
 * turned, and acts on a threshold the user can see.
 *
 * Two further rules protect money already made:
 *   · breakeven — once the premium has travelled half the distance to the
 *     first target, the stop moves to entry;
 *   · give-back — a trade that was up a full risk unit and has given most of
 *     it back is closed rather than ridden to the stop.
 */

export interface DirectionRead {
  /** Rule score 0–100 on the bias chart (1h intraday, 1d swing). */
  biasScore: number | null;
  biasTimeframe: '1h' | '1d';
  /** Rule score 0–100 on the 15-minute chart. */
  timingScore: number | null;
  supertrend: 1 | -1 | null;
  aboveVwap: boolean | null;
  /** EMA 9 above EMA 20 on the 15-minute chart. */
  emaUp: boolean | null;
  asOf: string | null;
}

export interface GuardedPosition {
  action: 'BUY_CALL' | 'BUY_PUT';
  horizon: 'intraday' | 'swing';
  entryPremium: number;
  premium: number;
  stopPremium: number;
  target1Premium: number;
  /** Best premium seen since entry, when tracked. */
  maxFavourablePremium: number | null;
}

export interface DirectionGuardConfig {
  /** Intraday: how many timing readings must turn before closing. */
  intradayTurnThreshold: number;
  /** Swing: how many must turn, and only while the trade is losing. */
  swingTurnThreshold: number;
  /** Close when the bias score's support for the side has faded below this while losing and a timing reading has turned. */
  fadedSupportBelow: number;
  /** Intraday: cut a loser once it is this many risk units below entry and a reading has turned. 0 disables. */
  cutLoserAtR: number;
}

export const DEFAULT_GUARD: DirectionGuardConfig = { intradayTurnThreshold: 2, swingTurnThreshold: 3, fadedSupportBelow: 55, cutLoserAtR: 0.5 };

export type GuardCode = 'DIRECTION' | 'SCORE' | 'GIVEBACK';

export type GuardDecision =
  | { kind: 'HOLD'; against: string[]; readable: number; note: string }
  | { kind: 'EXIT'; code: GuardCode; against: string[]; readable: number; reason: string }
  | { kind: 'RAISE_STOP'; newStop: number; against: string[]; readable: number; reason: string };

export function decideDirectionExit(p: GuardedPosition, r: DirectionRead, cfg: DirectionGuardConfig = DEFAULT_GUARD): GuardDecision {
  const bull = p.action === 'BUY_CALL';
  const against: string[] = [];
  let readable = 0;

  // ── the bias chart: the reason for the trade ──
  const biasAgainst = r.biasScore !== null && (bull ? r.biasScore < 50 : r.biasScore > 50);
  if (r.biasScore !== null) {
    readable += 1;
    if (biasAgainst) against.push(`${r.biasTimeframe} rule score ${r.biasScore.toFixed(0)} has crossed through 50 against the position`);
  }

  // ── the timing chart ──
  const timing: Array<[boolean | null, string]> = [
    [r.supertrend === null ? null : (bull ? r.supertrend === -1 : r.supertrend === 1), `15m supertrend is ${r.supertrend === 1 ? 'up' : 'down'}`],
    [r.aboveVwap === null ? null : (bull ? !r.aboveVwap : r.aboveVwap), `price is ${r.aboveVwap ? 'above' : 'below'} VWAP`],
    [r.emaUp === null ? null : (bull ? !r.emaUp : r.emaUp), `15m EMA 9 is ${r.emaUp ? 'above' : 'below'} EMA 20`],
    [r.timingScore === null ? null : (bull ? r.timingScore < 45 : r.timingScore > 55), `15m rule score is ${r.timingScore?.toFixed(0)}`],
  ];
  let turned = 0;
  for (const [isAgainst, label] of timing) {
    if (isAgainst === null) continue;
    readable += 1;
    if (isAgainst) { turned += 1; against.push(label); }
  }

  const losing = p.premium <= p.entryPremium;
  const riskUnit = Math.max(0.05, p.entryPremium - p.stopPremium);
  const rewardUnit = Math.max(0.05, p.target1Premium - p.entryPremium);
  const best = Math.max(p.maxFavourablePremium ?? p.premium, p.premium);

  // 1. The bias has flipped: the reason for the trade is gone.
  if (biasAgainst) {
    return { kind: 'EXIT', code: 'DIRECTION', against, readable, reason: `Direction changed: ${against[0]}.` };
  }

  // 2. The timing chart has turned.
  const threshold = p.horizon === 'intraday' ? cfg.intradayTurnThreshold : cfg.swingTurnThreshold;
  if (turned >= threshold && (p.horizon === 'intraday' || losing)) {
    return {
      kind: 'EXIT', code: 'DIRECTION', against, readable,
      reason: `Direction changed: ${turned} of ${readable - (r.biasScore !== null ? 1 : 0)} timing readings turned (${against.join('; ')}).`,
    };
  }

  // 2b. Intraday and already down half a risk unit with any reading turned:
  //     the move is not happening; do not wait for the premium stop.
  if (p.horizon === 'intraday' && cfg.cutLoserAtR > 0 && turned >= 1 && p.premium <= p.entryPremium - riskUnit * cfg.cutLoserAtR) {
    return {
      kind: 'EXIT', code: 'DIRECTION', against, readable,
      reason: `Losing with the chart turning: premium ₹${p.premium.toFixed(2)} is more than half a risk unit below entry ₹${p.entryPremium.toFixed(2)} and ${against.join('; ')}.`,
    };
  }

  // 3. Support has faded: the bias score is barely on side, a timing reading has
  //    turned, and the trade is losing. Read the score from the side's point of view.
  const support = r.biasScore === null ? null : bull ? r.biasScore : 100 - r.biasScore;
  if (support !== null && losing && turned >= 1 && support < cfg.fadedSupportBelow) {
    return {
      kind: 'EXIT', code: 'SCORE', against, readable,
      reason: `Score faded: ${r.biasTimeframe} support for the ${bull ? 'call' : 'put'} is ${support.toFixed(0)}/100 (${against.join('; ')}) with the premium below entry.`,
    };
  }

  // 4. Give-back: it was up a full risk unit and has handed most of it back.
  if (best >= p.entryPremium + riskUnit && p.premium <= p.entryPremium + riskUnit * 0.25) {
    return {
      kind: 'EXIT', code: 'GIVEBACK', against, readable,
      reason: `Profit give-back: the premium reached ₹${best.toFixed(2)} and is back to ₹${p.premium.toFixed(2)}; closing before it becomes a loss.`,
    };
  }

  // 5. Breakeven: halfway to the first target, the stop goes to entry.
  if (best >= p.entryPremium + rewardUnit * 0.5 && p.stopPremium < p.entryPremium) {
    return {
      kind: 'RAISE_STOP', newStop: p.entryPremium, against, readable,
      reason: `Halfway to target (best ₹${best.toFixed(2)}); stop raised from ₹${p.stopPremium.toFixed(2)} to breakeven ₹${p.entryPremium.toFixed(2)}.`,
    };
  }

  return {
    kind: 'HOLD', against, readable,
    note: against.length === 0 ? 'Every readable chart signal still agrees with the position.' : `${turned} of ${readable} readings against; below the ${threshold} needed to act.`,
  };
}
