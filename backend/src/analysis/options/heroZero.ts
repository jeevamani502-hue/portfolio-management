/**
 * Hero Zero — the expiry-day cheap-option momentum trade.
 *
 * The idea, as traders use it: on expiry day, after the market has picked a
 * direction and is moving with it, buy a far-out-of-the-money option for a
 * few rupees. If the move keeps going into the close the premium can multiply
 * (the "hero"); if it does not, the option expires worthless (the "zero").
 *
 * This module is deliberately separate from the 21-factor checklist engine.
 * That engine sizes a position from risk per trade and a stop; this one
 * cannot, because the honest stop for a ₹5 option is ₹0. So here:
 *
 *   · the budget is a fixed rupee amount the user states, treated as spent
 *     the moment the order fills;
 *   · the conditions are a short momentum checklist, counted, never
 *     turned into a probability;
 *   · a trade is suggested only when most of them agree, inside a window
 *     in the afternoon of expiry day, and is flattened before the close.
 *
 * Nothing here is a prediction. It is a description of whether the day
 * currently looks like one on which this trade has historically been
 * attempted — nothing more.
 */
import type { TechnicalSnapshot } from '../snapshot.js';
import type { Candle } from '../indicators/index.js';
import type { NormalizedOptionChain, OptionLeg } from '../../providers/types.js';
import { toIst } from '../../utils/time.js';

export interface HeroZeroConfig {
  /** Rupees of premium per attempt. All of it is at risk. */
  budget: number;
  minPremium: number;
  maxPremium: number;
  maxLots: number;
  windowStartMin: number;
  windowEndMin: number;
  squareOffMin: number;
  /** 0 rides it to zero; otherwise exit once the premium has fallen this much. */
  stopPct: number;
  /** Target 2 as a multiple of entry; target 1 sits halfway there. */
  targetMultiple: number;
  /** Conditions that must agree before a trade is suggested. */
  minAgree: number;
}

export interface HeroZeroInput {
  underlying: string;
  expiry: string;
  daysToExpiry: number;
  chain: NormalizedOptionChain;
  /** Five-minute snapshot of the underlying, as of the last closed bar. */
  intraday: TechnicalSnapshot | null;
  /** Today's five-minute candles, oldest first. */
  todayCandles: readonly Candle[];
  market: { phase: string; minutesOfDay: number };
  cfg: HeroZeroConfig;
  now: Date;
}

export type FactorStatus = 'AGREE' | 'AGAINST' | 'UNREADABLE';

export interface HeroZeroFactor {
  code: string;
  label: string;
  status: FactorStatus;
  detail: string;
}

export interface HeroZeroGate {
  code: string;
  ok: boolean;
  detail: string;
}

export interface HeroZeroCandidate {
  strike: number;
  optionType: 'CE' | 'PE';
  action: 'BUY_CALL' | 'BUY_PUT';
  premium: number;
  bid: number | null;
  ask: number | null;
  oi: number | null;
  volume: number | null;
  lotSize: number;
  lots: number;
  quantity: number;
  /** Limit price for the entry: the ask when there is one, else one tick over the last trade. */
  limit: number;
  outlay: number;
  stopPremium: number;
  target1Premium: number;
  target2Premium: number;
  underlyingStop: number;
  underlyingTarget1: number;
  underlyingTarget2: number;
  /** Distance from spot to the strike, in percent. */
  otmPct: number;
}

export type HeroZeroStance = 'ENTER' | 'WAIT' | 'AVOID';

export interface HeroZeroDecision {
  underlying: string;
  expiry: string;
  daysToExpiry: number;
  spot: number | null;
  side: 'BUY_CALL' | 'BUY_PUT' | null;
  stance: HeroZeroStance;
  agreeing: number;
  readable: number;
  factors: HeroZeroFactor[];
  gates: HeroZeroGate[];
  candidate: HeroZeroCandidate | null;
  /** Why no contract qualified, when candidate is null. */
  candidateNote: string | null;
  summary: string;
  warning: string;
  asOf: string;
}

export const HERO_ZERO_WARNING =
  'Most Hero Zero trades expire worthless. The budget is the amount you are prepared to lose in full on this one attempt; ' +
  'the conditions below describe the day, they do not predict it.';

const TICK = 0.05;
const roundTick = (p: number): number => Math.round(p / TICK) * TICK;
const pct = (a: number, b: number): number => ((a - b) / b) * 100;
const minutesLabel = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * The momentum checklist. Each condition votes for calls, puts, or cannot
 * be read. The side is the majority of the first three (the trend trio);
 * every condition is then scored against that side.
 */
function readFactors(s: TechnicalSnapshot | null, today: readonly Candle[]): { side: 'BUY_CALL' | 'BUY_PUT' | null; factors: HeroZeroFactor[] } {
  type Vote = { code: string; label: string; vote: 'CE' | 'PE' | null; detail: string };
  const votes: Vote[] = [];
  const close = s?.price.close ?? today[today.length - 1]?.close ?? null;

  // 1. Price against VWAP.
  if (s && s.vwap !== null && close !== null) {
    const v = pct(close, s.vwap);
    votes.push({ code: 'vwap', label: 'Price against the day\'s VWAP', vote: v > 0.05 ? 'CE' : v < -0.05 ? 'PE' : null,
      detail: `Spot ${close.toFixed(2)} is ${Math.abs(v).toFixed(2)}% ${v >= 0 ? 'above' : 'below'} VWAP ${s.vwap.toFixed(2)}.` });
  } else votes.push({ code: 'vwap', label: 'Price against the day\'s VWAP', vote: null, detail: 'VWAP is not available on this feed.' });

  // 2. Fast EMA over slow EMA on the 5-minute chart.
  if (s && s.movingAverages.ema9 !== null && s.movingAverages.ema20 !== null) {
    const d = pct(s.movingAverages.ema9, s.movingAverages.ema20);
    votes.push({ code: 'ema', label: '5-minute EMA 9 against EMA 20', vote: d > 0.02 ? 'CE' : d < -0.02 ? 'PE' : null,
      detail: `EMA 9 ${s.movingAverages.ema9.toFixed(2)} is ${d >= 0 ? 'above' : 'below'} EMA 20 ${s.movingAverages.ema20.toFixed(2)}.` });
  } else votes.push({ code: 'ema', label: '5-minute EMA 9 against EMA 20', vote: null, detail: 'Not enough 5-minute bars.' });

  // 3. Supertrend direction.
  if (s && s.trend.supertrendDirection !== null) {
    votes.push({ code: 'supertrend', label: '5-minute supertrend', vote: s.trend.supertrendDirection === 1 ? 'CE' : 'PE',
      detail: `Supertrend is ${s.trend.supertrendDirection === 1 ? 'up' : 'down'}${s.trend.supertrend !== null ? ` at ${s.trend.supertrend.toFixed(2)}` : ''}.` });
  } else votes.push({ code: 'supertrend', label: '5-minute supertrend', vote: null, detail: 'Supertrend unreadable.' });

  // 4. A fresh break of the day's range in the last three bars.
  if (today.length >= 6 && close !== null) {
    const recent = today.slice(-3);
    const before = today.slice(0, -3);
    const hi = Math.max(...before.map((c) => c.high));
    const lo = Math.min(...before.map((c) => c.low));
    const brokeUp = recent.some((c) => c.close > hi);
    const brokeDown = recent.some((c) => c.close < lo);
    votes.push({ code: 'breakout', label: 'Fresh break of the day\'s range', vote: brokeUp && !brokeDown ? 'CE' : brokeDown && !brokeUp ? 'PE' : null,
      detail: brokeUp && !brokeDown ? `Closed above the day's high ${hi.toFixed(2)} within the last three bars.`
        : brokeDown && !brokeUp ? `Closed below the day's low ${lo.toFixed(2)} within the last three bars.`
        : `Still inside the day's range ${lo.toFixed(2)}–${hi.toFixed(2)}.` });
  } else votes.push({ code: 'breakout', label: 'Fresh break of the day\'s range', vote: null, detail: 'Fewer than six bars today.' });

  // 5. RSI with room to run in the direction of the move.
  if (s && s.momentum.rsi14 !== null) {
    const r = s.momentum.rsi14;
    votes.push({ code: 'rsi', label: '5-minute RSI pushing', vote: r >= 60 && r < 85 ? 'CE' : r <= 40 && r > 15 ? 'PE' : null,
      detail: `RSI 14 is ${r.toFixed(1)}${r >= 85 || r <= 15 ? ' — stretched; a fresh buy here chases.' : ''}.` });
  } else votes.push({ code: 'rsi', label: '5-minute RSI pushing', vote: null, detail: 'RSI unreadable.' });

  // 6. Volume behind the move.
  if (s && s.volume.relativeVolume !== null) {
    const rv = s.volume.relativeVolume;
    const dir = close !== null ? (close >= s.price.open ? 'CE' : 'PE') : null;
    votes.push({ code: 'volume', label: 'Volume behind the last bar', vote: rv >= 1.2 ? dir : null,
      detail: `Last bar's volume is ${rv.toFixed(2)}× its 20-bar average${rv >= 1.2 ? '' : ' — no urgency.'}.` });
  } else votes.push({ code: 'volume', label: 'Volume behind the last bar', vote: null, detail: 'Index feeds often carry no volume; unreadable.' });

  // 7. The day itself is moving, not drifting.
  if (today.length >= 2) {
    const open = today[0]!.open;
    const move = close === null ? null : pct(close, open);
    votes.push({ code: 'day_move', label: 'The day is moving', vote: move === null ? null : move >= 0.25 ? 'CE' : move <= -0.25 ? 'PE' : null,
      detail: move === null ? 'No close.' : `${Math.abs(move).toFixed(2)}% ${move >= 0 ? 'up' : 'down'} from today's open ${open.toFixed(2)}${Math.abs(move) < 0.25 ? ' — a drift, not a move.' : '.'}` });
  } else votes.push({ code: 'day_move', label: 'The day is moving', vote: null, detail: 'No bars yet today.' });

  const trio = votes.slice(0, 3).filter((v) => v.vote !== null);
  const ce = trio.filter((v) => v.vote === 'CE').length;
  const pe = trio.filter((v) => v.vote === 'PE').length;
  const side: 'BUY_CALL' | 'BUY_PUT' | null = ce > pe ? 'BUY_CALL' : pe > ce ? 'BUY_PUT' : null;
  const want = side === 'BUY_CALL' ? 'CE' : side === 'BUY_PUT' ? 'PE' : null;

  const factors: HeroZeroFactor[] = votes.map((v) => ({
    code: v.code, label: v.label, detail: v.detail,
    status: v.vote === null ? 'UNREADABLE' : want === null ? 'AGAINST' : v.vote === want ? 'AGREE' : 'AGAINST',
  }));
  return { side, factors };
}

/** Pick the cheapest usable strike on the chosen side, nearest the money within the premium band. */
export function pickHeroZeroContract(
  chain: NormalizedOptionChain,
  side: 'BUY_CALL' | 'BUY_PUT',
  cfg: HeroZeroConfig,
  anchor: { underlyingStop: number },
): { candidate: HeroZeroCandidate | null; note: string | null } {
  const spot = chain.spot;
  const lotSize = chain.lotSize;
  if (spot === null) return { candidate: null, note: 'The chain carries no spot price.' };
  if (!lotSize) return { candidate: null, note: 'The chain carries no lot size.' };
  const bull = side === 'BUY_CALL';

  const rows = chain.strikes
    .map((s) => ({ strike: s.strike, leg: bull ? s.call : s.put }))
    .filter((r): r is { strike: number; leg: OptionLeg } => r.leg !== null && r.leg.ltp !== null && r.leg.ltp > 0)
    .filter((r) => (bull ? r.strike > spot : r.strike < spot))
    .filter((r) => r.leg.ltp! >= cfg.minPremium && r.leg.ltp! <= cfg.maxPremium)
    .sort((a, b) => (bull ? a.strike - b.strike : b.strike - a.strike)); // nearest the money first

  if (rows.length === 0) {
    return { candidate: null, note: `No ${bull ? 'call' : 'put'} strike out of the money is priced between ₹${cfg.minPremium} and ₹${cfg.maxPremium}.` };
  }

  for (const r of rows) {
    const leg = r.leg;
    const ltp = leg.ltp!;
    if (leg.bid !== null && leg.ask !== null && leg.bid > 0 && (leg.ask - leg.bid) / ltp > 0.25) continue; // too wide to fill sensibly
    if (leg.oi !== null && leg.oi === 0) continue;
    const limit = roundTick(leg.ask !== null && leg.ask > 0 ? leg.ask : ltp + TICK);
    const perLot = limit * lotSize;
    const lots = Math.min(cfg.maxLots, Math.floor(cfg.budget / perLot));
    if (lots < 1) {
      return { candidate: null, note: `One lot of ${r.strike} ${bull ? 'CE' : 'PE'} costs ₹${perLot.toFixed(0)}, more than the ₹${cfg.budget} budget.` };
    }
    const stopPremium = cfg.stopPct > 0 ? Math.max(TICK, roundTick(limit * (1 - cfg.stopPct / 100))) : TICK;
    const target2 = roundTick(limit * cfg.targetMultiple);
    const target1 = roundTick(limit * (1 + (cfg.targetMultiple - 1) / 2));
    const dist = Math.abs(r.strike - spot);
    return {
      candidate: {
        strike: r.strike, optionType: bull ? 'CE' : 'PE', action: side,
        premium: ltp, bid: leg.bid, ask: leg.ask, oi: leg.oi, volume: leg.volume,
        lotSize, lots, quantity: lots * lotSize, limit, outlay: limit * lots * lotSize,
        stopPremium, target1Premium: target1, target2Premium: target2,
        underlyingStop: anchor.underlyingStop,
        underlyingTarget1: r.strike,
        underlyingTarget2: bull ? r.strike + dist : r.strike - dist,
        otmPct: (dist / spot) * 100,
      },
      note: null,
    };
  }
  return { candidate: null, note: 'Every strike in the premium band has a bid-ask spread too wide to fill sensibly or no open interest.' };
}

export function buildHeroZeroDecision(input: HeroZeroInput): HeroZeroDecision {
  const { cfg, chain, market } = input;
  const spot = chain.spot ?? input.intraday?.price.close ?? null;
  const { side, factors } = readFactors(input.intraday, input.todayCandles);
  const readable = factors.filter((f) => f.status !== 'UNREADABLE').length;
  const agreeing = factors.filter((f) => f.status === 'AGREE').length;

  const gates: HeroZeroGate[] = [
    { code: 'expiry_day', ok: input.daysToExpiry === 0,
      detail: input.daysToExpiry === 0 ? `${input.expiry} expires today.` : `${input.expiry} is ${input.daysToExpiry} day(s) away; Hero Zero is an expiry-day trade only.` },
    { code: 'market_open', ok: market.phase === 'OPEN', detail: market.phase === 'OPEN' ? 'Market is open.' : `Market is ${market.phase.toLowerCase().replace(/_/g, ' ')}.` },
    { code: 'window', ok: market.minutesOfDay >= cfg.windowStartMin && market.minutesOfDay <= cfg.windowEndMin,
      detail: `Window ${minutesLabel(cfg.windowStartMin)}–${minutesLabel(cfg.windowEndMin)} IST; it is ${minutesLabel(market.minutesOfDay)}.` },
    { code: 'side', ok: side !== null, detail: side === null ? 'The trend trio (VWAP, EMAs, supertrend) does not agree on a direction.' : `Direction: ${side === 'BUY_CALL' ? 'calls' : 'puts'}.` },
  ];
  const gatesOk = gates.every((g) => g.ok);

  // Thesis anchor: if the underlying falls back through VWAP (or the fast EMA)
  // the momentum that justified the buy is gone.
  const s = input.intraday;
  const anchor = s?.vwap ?? s?.movingAverages.ema20 ?? (input.todayCandles.length ? (side === 'BUY_CALL'
    ? Math.min(...input.todayCandles.map((c) => c.low)) : Math.max(...input.todayCandles.map((c) => c.high))) : spot ?? 0);

  let candidate: HeroZeroCandidate | null = null;
  let candidateNote: string | null = null;
  if (side !== null) {
    const picked = pickHeroZeroContract(chain, side, cfg, { underlyingStop: anchor });
    candidate = picked.candidate;
    candidateNote = picked.note;
  }

  const stance: HeroZeroStance =
    !gatesOk ? 'AVOID'
    : agreeing >= cfg.minAgree && candidate !== null ? 'ENTER'
    : agreeing >= Math.max(3, cfg.minAgree - 2) ? 'WAIT'
    : 'AVOID';

  const failedGate = gates.find((g) => !g.ok);
  const summary =
    stance === 'ENTER'
      ? `${agreeing} of ${readable} readable conditions point to ${side === 'BUY_CALL' ? 'calls' : 'puts'}; ${candidate!.strike} ${candidate!.optionType} at about ₹${candidate!.premium.toFixed(2)}, ${candidate!.lots} lot(s) for ₹${candidate!.outlay.toFixed(0)}.`
    : failedGate ? failedGate.detail
    : candidate === null && side !== null ? (candidateNote ?? 'No contract qualifies.')
    : `${agreeing} of ${readable} readable conditions agree; ${cfg.minAgree} are needed. ${stance === 'WAIT' ? 'Watching.' : 'Not a Hero Zero day so far.'}`;

  return {
    underlying: input.underlying, expiry: input.expiry, daysToExpiry: input.daysToExpiry, spot,
    side, stance, agreeing, readable, factors, gates, candidate, candidateNote, summary,
    warning: HERO_ZERO_WARNING,
    asOf: s?.asOf ?? toIst(input.now).dateKey,
  };
}
