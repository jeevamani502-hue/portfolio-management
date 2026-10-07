/**
 * F&O decision engine — the checklist a discretionary index-option trader
 * runs before buying a call or a put, made explicit and reproducible.
 *
 * The setup engine (setupEngine.ts) answers "which contract, at what price,
 * how many lots, where is the stop". It is deliberately narrow. This layer
 * answers the question that comes before it: *should this trade be taken
 * at all, right now* — and it answers with a graded checklist rather than a
 * single number, because that is how the decision is actually made:
 *
 *   direction   the higher timeframe sets the bias; structure and the
 *               matched setup must agree with it; momentum must not already
 *               be exhausted; the market regime should not be fighting it
 *   timing      the lower timeframe has to agree — buying a call into a
 *               15-minute downtrend below VWAP is paying theta to be early;
 *               fresh entries stay out of the opening noise and the close
 *   chain flow  positioning in the option chain — PCR, max pain, where OI
 *               is being added, the nearest wall — should not read against
 *               the direction
 *   volatility  a rich premium (high IV percentile, elevated VIX) and a
 *               near expiry both make a directional buy harder to win even
 *               when the direction is right
 *   risk        the contract has to survive to its own stop, the outlay has
 *               to be a sane share of capital, the payoff has to clear the
 *               floor
 *
 * Some factors are gates: fail one and there is no trade regardless of how
 * the rest score. The rest are weighted, and the score is the weighted share
 * of *evaluable* factors that support the trade. An unavailable input lowers
 * coverage rather than silently counting for or against.
 *
 * What the grade is not: a probability. It is a count of independent
 * conditions that currently agree, and the only honest measure of how often
 * such trades work is the signal journal, which records every graded signal
 * and what happened to it afterwards.
 *
 * Pure: no clock, no network, no database. Everything is passed in.
 */
import type { NormalizedOptionChain } from '../../providers/types.js';
import type { TechnicalSnapshot } from '../snapshot.js';
import type { SignalReport, SetupKind } from '../signals/engine.js';
import type { RegimeResult } from '../regime.js';
import type { MarketPhase } from '../../utils/time.js';
import { fromIst, toIst } from '../../utils/time.js';
import {
  buildOptionSetup, type OptionSetup, type OptionAction, type Bias,
} from './setupEngine.js';
import {
  calculatePcr, calculateMaxPain, deriveOiLevels, analyzeOiShift,
} from './analytics.js';

export type Grade = 'A' | 'B' | 'C' | 'NONE';
export type Stance = 'ENTER' | 'WAIT' | 'AVOID';
export type FactorGroup = 'direction' | 'timing' | 'chain' | 'volatility' | 'risk';
export type Verdict = 'pass' | 'fail' | 'na';

export interface DecisionFactor {
  id: string;
  label: string;
  group: FactorGroup;
  /** pass supports the trade, fail argues against it, na could not be read. */
  verdict: Verdict;
  weight: number;
  /** The measured observation behind the verdict, in plain words. */
  observed: string;
  /** A failed gate means no trade whatever the rest of the checklist says. */
  gate: boolean;
}

export interface TradePlan {
  entryPremium: number;
  /** Where a limit order is reasonable: the quoted spread, or ±1% without one. */
  entryZone: { low: number; high: number };
  stopPremium: number;
  target1Premium: number;
  target2Premium: number;
  underlyingEntry: number;
  underlyingStop: number;
  underlyingTarget1: number;
  underlyingTarget2: number;
  rewardRisk1: number | null;
  rewardRisk2: number | null;
  lots: number;
  quantity: number;
  premiumOutlay: number;
  riskAtStop: number;
  /** When to give up on the idea even if neither level is hit. */
  timeStop: string;
  /** In the order they should be applied. */
  exitRules: string[];
}

export interface FnoDecision {
  underlying: string;
  expiry: string;
  daysToExpiry: number;
  bias: Bias;
  stance: Stance;
  grade: Grade;
  action: OptionAction;
  /** 0–100 weighted share of evaluable factors supporting the trade. Not a probability. */
  score: number;
  /** Share of the checklist's weight that could actually be evaluated, 0–100. */
  coverage: number;
  factors: DecisionFactor[];
  gatesFailed: string[];
  /** Whether a fresh entry is inside the session window right now. */
  entryWindowOpen: boolean;
  sessionNote: string;
  /** Contract, pricing and sizing. `confirmation` is replaced by `score`. */
  setup: OptionSetup;
  plan: TradePlan | null;
  /** Conditions that would flip this read — the levels to watch. */
  whatChangesMyMind: string[];
  summary: string;
  /** Reasons the stance is not ENTER, when it is not. */
  holdBecause: string[];
}

export interface TimeframeView {
  snapshot: TechnicalSnapshot;
  report: SignalReport;
}

export interface FnoDecisionInput {
  underlying: string;
  chain: NormalizedOptionChain;
  /** Higher timeframe (normally daily): sets the bias. */
  daily: TimeframeView;
  /** Lower timeframe (normally 15m): times the entry. Null when unavailable. */
  intraday: TimeframeView | null;
  regime: RegimeResult | null;
  /** India VIX level, if quoted. */
  vix: number | null;
  /** ATM IV percentile over stored history, if enough history exists. */
  ivPercentile: number | null;
  market: { phase: MarketPhase; minutesOfDay: number };
  capital: number;
  riskPercent: number;
  atrStopMultiple?: number;
  minRewardRisk?: number;
  now?: Date;
}

// ── thresholds ──────────────────────────────────────────────────────────────
// Judgement calls about someone's money, kept together so a change is visible.

/** Daily score above which the bias is bullish; mirror image for bearish. */
export const BULLISH_ABOVE = 60;
export const BEARISH_BELOW = 40;
/** Lower-timeframe agreement thresholds, looser than the bias thresholds. */
const INTRADAY_AGREE_BULL = 55;
const INTRADAY_AGREE_BEAR = 45;
/** RSI beyond which buying in the direction of the move is chasing. */
const RSI_EXHAUSTED_HIGH = 75;
const RSI_EXHAUSTED_LOW = 25;
/** Fresh entries only between these IST minutes on an open session. */
export const ENTRY_WINDOW_START = 9 * 60 + 30;
export const ENTRY_WINDOW_END = 15 * 60;
/** Below this many calendar days to expiry, no fresh option buys. */
export const MIN_DAYS_TO_EXPIRY = 2;
const IV_PERCENTILE_RICH = 80;
const VIX_ELEVATED = 20;
const VIX_HIGH = 25;
/** Premium outlay above this share of capital is flagged. */
const OUTLAY_SHARE_WARN = 0.25;
/** Second target, as a multiple of the stop distance on the underlying. */
const TARGET2_R = 2.5;

const GRADE_A_SCORE = 75;
const GRADE_B_SCORE = 60;
const GRADE_C_SCORE = 45;
/**
 * Below this coverage the grade is capped at C: too little was readable.
 *
 * Daily bias plus the risk block alone is about half the checklist's weight,
 * and that is one lens — with no timing, no chain positioning and no
 * volatility context, a high score says only that the daily read is tidy.
 */
const MIN_COVERAGE_FOR_ENTRY = 0.6;

const BULLISH_SETUPS: ReadonlySet<SetupKind> = new Set(['BREAKOUT', 'PULLBACK', 'MOMENTUM']);
const BEARISH_SETUPS: ReadonlySet<SetupKind> = new Set(['BREAKDOWN']);

const fmt = (v: number | null | undefined, dp = 2): string =>
  v === null || v === undefined ? 'n/a' : v.toFixed(dp);

/** Calendar days from `now` (IST date) to the expiry date. 0 on expiry day. */
export function calendarDaysToExpiry(expiry: string, now: Date): number {
  const today = toIst(now).dateKey;
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${expiry}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 864e5);
}

/** The instant an expiry stops trading: 15:30 IST on the expiry date. */
export const expiryInstant = (expiry: string): Date => fromIst(expiry, 15, 30);

export function buildFnoDecision(input: FnoDecisionInput): FnoDecision {
  const {
    underlying, chain, daily, intraday, regime, vix, ivPercentile, market,
    capital, riskPercent, atrStopMultiple = 1.5, minRewardRisk = 1.5, now = new Date(),
  } = input;

  const factors: DecisionFactor[] = [];
  const add = (f: Omit<DecisionFactor, 'gate'> & { gate?: boolean }) =>
    factors.push({ ...f, gate: f.gate ?? false });

  const spot = chain.spot;
  const dailyScore = daily.report.overallScore;
  const bias: Bias =
    dailyScore === null ? 'NEUTRAL'
    : dailyScore >= BULLISH_ABOVE ? 'BULLISH'
    : dailyScore <= BEARISH_BELOW ? 'BEARISH'
    : 'NEUTRAL';
  const bull = bias === 'BULLISH';
  const daysToExpiry = calendarDaysToExpiry(chain.expiry, now);

  // ── direction ─────────────────────────────────────────────────────────────

  add({
    id: 'daily_bias', label: `${daily.snapshot.timeframe} rule score has a direction`,
    group: 'direction', weight: 3, gate: true,
    verdict: dailyScore === null ? 'na' : bias === 'NEUTRAL' ? 'fail' : 'pass',
    observed: dailyScore === null
      ? 'The rule engine could not score the underlying'
      : `Score ${dailyScore.toFixed(0)}/100 — ${bias === 'NEUTRAL'
          ? `inside the ${BEARISH_BELOW}–${BULLISH_ABOVE} band where the rules do not agree`
          : `${bias.toLowerCase()} (${bull ? `≥ ${BULLISH_ABOVE}` : `≤ ${BEARISH_BELOW}`})`}`,
  });

  const trend = daily.snapshot.trend.assessment;
  {
    const label = trend.label;
    const agrees = bull
      ? label === 'UPTREND' || label === 'STRONG_UPTREND'
      : label === 'DOWNTREND' || label === 'STRONG_DOWNTREND';
    add({
      id: 'structure_agrees', label: 'Swing structure agrees with the bias',
      group: 'direction', weight: 2,
      verdict: bias === 'NEUTRAL' || label === 'UNDETERMINED' ? 'na' : agrees ? 'pass' : 'fail',
      observed: label === 'UNDETERMINED'
        ? 'Not enough completed swings to classify structure'
        : `Structure reads ${label.replace(/_/g, ' ').toLowerCase()}${trend.reasons[0] ? ` — ${trend.reasons[0].toLowerCase()}` : ''}`,
    });
  }

  {
    const wanted = bull ? BULLISH_SETUPS : BEARISH_SETUPS;
    const match = daily.report.setups.find(
      (s) => wanted.has(s.kind) && s.direction === bias && s.strength >= 50,
    ) ?? daily.report.setups.find((s) => s.direction === bias && s.strength >= 50);
    add({
      id: 'setup_present', label: 'A named setup has formed in that direction',
      group: 'direction', weight: 2,
      verdict: bias === 'NEUTRAL' ? 'na' : match ? 'pass' : 'fail',
      observed: match
        ? `${match.label} at ${match.strength}/100 confirmation`
        : `No ${bias.toLowerCase()} setup has formed on the ${daily.snapshot.timeframe} bars — the score leans that way without a defined pattern behind it`,
    });
  }

  {
    const rsi = daily.snapshot.momentum.rsi14;
    const exhausted = rsi !== null && (bull ? rsi > RSI_EXHAUSTED_HIGH : rsi < RSI_EXHAUSTED_LOW);
    add({
      id: 'not_exhausted', label: 'Momentum is not already stretched',
      group: 'direction', weight: 1,
      verdict: rsi === null || bias === 'NEUTRAL' ? 'na' : exhausted ? 'fail' : 'pass',
      observed: rsi === null
        ? 'RSI unavailable'
        : `RSI(14) is ${rsi.toFixed(1)}${exhausted ? ` — beyond ${bull ? RSI_EXHAUSTED_HIGH : RSI_EXHAUSTED_LOW}, so buying here is chasing a move that has already run` : ''}`,
    });
  }

  {
    let verdict: Verdict = 'na';
    let observed = 'Market regime unavailable';
    if (regime && bias !== 'NEUTRAL') {
      const r = regime.regime;
      if (r === 'UNDETERMINED') {
        observed = 'Regime could not be determined';
      } else if (r === 'HIGH_VOLATILITY') {
        verdict = 'fail';
        observed = 'Regime is high volatility — direction is less persistent and premiums are rich';
      } else if (r === 'RANGE') {
        verdict = 'fail';
        observed = 'The broad market is in a range; directional option buys bleed theta in a range';
      } else {
        const up = r === 'UPTREND' || r === 'STRONG_UPTREND';
        verdict = up === bull ? 'pass' : 'fail';
        observed = `Broad-market regime is ${r.replace(/_/g, ' ').toLowerCase()} (composite ${fmt(regime.compositeScore, 0)})`;
      }
    }
    add({ id: 'regime_alignment', label: 'Broad-market regime is not fighting the trade',
      group: 'direction', weight: 1.5, verdict, observed });
  }

  // ── timing ────────────────────────────────────────────────────────────────

  const intradayScore = intraday?.report.overallScore ?? null;
  {
    const agrees = intradayScore !== null
      && (bull ? intradayScore >= INTRADAY_AGREE_BULL : intradayScore <= INTRADAY_AGREE_BEAR);
    add({
      id: 'intraday_agrees', label: 'Lower timeframe agrees',
      group: 'timing', weight: 2.5,
      verdict: intradayScore === null || bias === 'NEUTRAL' ? 'na' : agrees ? 'pass' : 'fail',
      observed: intraday === null
        ? 'No intraday history available to time the entry'
        : intradayScore === null
          ? `${intraday.snapshot.timeframe} bars could not be scored`
          : `${intraday.snapshot.timeframe} score ${intradayScore.toFixed(0)}/100${agrees ? '' : ` — not yet ${bull ? `≥ ${INTRADAY_AGREE_BULL}` : `≤ ${INTRADAY_AGREE_BEAR}`}, so the entry timeframe has not turned`}`,
    });
  }

  {
    const v = intraday?.snapshot.vwap ?? null;
    const close = intraday?.snapshot.price.close ?? null;
    const onSide = v !== null && close !== null && (bull ? close > v : close < v);
    add({
      id: 'vwap_side', label: `Price is ${bull ? 'above' : 'below'} session VWAP`,
      group: 'timing', weight: 2,
      verdict: v === null || close === null || bias === 'NEUTRAL' ? 'na' : onSide ? 'pass' : 'fail',
      observed: v === null || close === null
        ? 'Session VWAP unavailable'
        : `${intraday!.snapshot.timeframe} close ${close.toFixed(2)} is ${close > v ? 'above' : 'below'} VWAP ${v.toFixed(2)}${onSide ? '' : ` — ${bull ? 'calls' : 'puts'} bought below VWAP are fighting the session's average buyer`}`,
    });
  }

  {
    const dir = intraday?.snapshot.trend.supertrendDirection ?? null;
    const agrees = dir !== null && (bull ? dir === 1 : dir === -1);
    add({
      id: 'intraday_trend_filter', label: 'Intraday trend filter agrees',
      group: 'timing', weight: 1.5,
      verdict: dir === null || bias === 'NEUTRAL' ? 'na' : agrees ? 'pass' : 'fail',
      observed: dir === null
        ? 'Intraday Supertrend unavailable'
        : `${intraday!.snapshot.timeframe} Supertrend is ${dir === 1 ? 'bullish' : 'bearish'}`,
    });
  }

  {
    const prevClose = daily.snapshot.price.prevClose;
    const ref = spot ?? daily.snapshot.price.close;
    const green = prevClose !== null && ref > prevClose;
    const agrees = bull ? green : prevClose !== null && ref < prevClose;
    add({
      id: 'session_direction', label: 'The session is moving the same way',
      group: 'timing', weight: 1,
      verdict: prevClose === null || bias === 'NEUTRAL' ? 'na' : agrees ? 'pass' : 'fail',
      observed: prevClose === null
        ? 'Previous close unavailable'
        : `${ref.toFixed(2)} vs previous close ${prevClose.toFixed(2)} (${(((ref - prevClose) / prevClose) * 100).toFixed(2)}%)`,
    });
  }

  const sessionOpen = market.phase === 'OPEN';
  const entryWindowOpen =
    sessionOpen && market.minutesOfDay >= ENTRY_WINDOW_START && market.minutesOfDay <= ENTRY_WINDOW_END;
  let sessionNote: string;
  if (!sessionOpen) {
    sessionNote =
      'The market is not in a live session. The plan below is built from the last available prices; ' +
      're-check it after 09:30 IST on the next trading day before acting.';
  } else if (market.minutesOfDay < ENTRY_WINDOW_START) {
    sessionNote =
      'First fifteen minutes of the session — the opening range is still forming and spreads are wide. ' +
      'No fresh entries before 09:30 IST.';
  } else if (market.minutesOfDay > ENTRY_WINDOW_END) {
    sessionNote =
      'Last thirty minutes of the session. A fresh option buy now carries overnight theta and gap risk ' +
      'for very little time to be right. No fresh entries after 15:00 IST.';
  } else {
    sessionNote = 'Inside the entry window (09:30–15:00 IST).';
  }
  add({
    id: 'entry_window', label: 'Inside the entry window',
    group: 'timing', weight: 1.5,
    verdict: !sessionOpen ? 'na' : entryWindowOpen ? 'pass' : 'fail',
    observed: sessionNote,
  });

  // ── chain flow ────────────────────────────────────────────────────────────

  const pcr = calculatePcr(chain);
  {
    const supportive = pcr.pcrOi !== null && (bull ? pcr.pcrOi >= 1.0 : pcr.pcrOi < 1.0);
    add({
      id: 'pcr_side', label: 'Put/call OI ratio reads with the bias',
      group: 'chain', weight: 1.5,
      verdict: pcr.pcrOi === null || bias === 'NEUTRAL' ? 'na' : supportive ? 'pass' : 'fail',
      observed: pcr.pcrOi === null
        ? 'Open interest unavailable'
        : `PCR (OI) ${pcr.pcrOi.toFixed(2)} — ${pcr.band.replace(/_/g, ' ')}; readings above 1 are conventionally read as supportive of the upside`,
    });
  }

  const maxPain = calculateMaxPain(chain);
  {
    const above = maxPain.maxPain !== null && spot !== null && maxPain.maxPain > spot;
    const agrees = maxPain.maxPain !== null && spot !== null && (bull ? above : !above);
    add({
      id: 'max_pain_side', label: 'Max pain sits on the trade\'s side of spot',
      group: 'chain', weight: 1,
      verdict: maxPain.maxPain === null || spot === null || bias === 'NEUTRAL' ? 'na' : agrees ? 'pass' : 'fail',
      observed: maxPain.maxPain === null || spot === null
        ? 'Max pain undefined'
        : `Max pain ${maxPain.maxPain.toFixed(0)} vs spot ${spot.toFixed(2)} — positioning ${agrees ? 'pulls toward' : 'pulls away from'} the trade`,
    });
  }

  const shift = analyzeOiShift(chain);
  {
    const known = shift.callOiChange !== 0 || shift.putOiChange !== 0;
    // Writers add puts under a market they expect to hold, and calls over one
    // they expect to stall. Net additions on the put side read as support.
    const putsAdded = shift.putOiChange > shift.callOiChange;
    const agrees = bull ? putsAdded : !putsAdded;
    add({
      id: 'oi_flow', label: 'Today\'s OI additions read with the bias',
      group: 'chain', weight: 1.5,
      verdict: !known || bias === 'NEUTRAL' ? 'na' : agrees ? 'pass' : 'fail',
      observed: !known
        ? 'No OI change reported yet in this chain'
        : `Put OI ${shift.putOiChange >= 0 ? '+' : ''}${shift.putOiChange.toLocaleString('en-IN')} vs call OI ${shift.callOiChange >= 0 ? '+' : ''}${shift.callOiChange.toLocaleString('en-IN')} — ${putsAdded ? 'put writers are adding (support being built)' : 'call writers are adding (resistance being built)'}`,
    });
  }

  const levels = deriveOiLevels(chain);
  {
    const wall = bull ? levels.resistances[0] : levels.supports[0];
    const distPct = wall && spot ? (Math.abs(wall.strike - spot) / spot) * 100 : null;
    const clear = distPct !== null && distPct >= 0.5;
    add({
      id: 'oi_wall_clearance', label: 'Room to the nearest OI wall',
      group: 'chain', weight: 1,
      verdict: !wall || spot === null || bias === 'NEUTRAL' ? 'na' : clear ? 'pass' : 'fail',
      observed: !wall || spot === null || distPct === null
        ? 'No OI wall mapped'
        : `Largest ${bull ? 'call' : 'put'} OI at ${wall.strike}, ${distPct.toFixed(2)}% from spot${clear ? '' : ' — moves often stall into a wall this close'}`,
    });
  }

  // ── volatility ────────────────────────────────────────────────────────────

  {
    const rich = ivPercentile !== null && ivPercentile >= IV_PERCENTILE_RICH;
    add({
      id: 'iv_not_rich', label: 'Implied volatility is not at the rich end of its range',
      group: 'volatility', weight: 1,
      verdict: ivPercentile === null ? 'na' : rich ? 'fail' : 'pass',
      observed: ivPercentile === null
        ? 'IV percentile needs more stored chain history'
        : `ATM IV is at the ${ivPercentile.toFixed(0)}th percentile of stored history${rich ? ' — the premium is expensive, and a directional buy must overcome that' : ''}`,
    });
  }

  {
    const verdict: Verdict = vix === null ? 'na' : vix >= VIX_ELEVATED ? 'fail' : 'pass';
    add({
      id: 'vix_level', label: 'India VIX is not elevated',
      group: 'volatility', weight: 1, verdict,
      observed: vix === null
        ? 'India VIX unavailable'
        : `India VIX ${vix.toFixed(2)} — ${vix >= VIX_HIGH ? 'high' : vix >= VIX_ELEVATED ? 'elevated' : 'subdued'}`,
    });
  }

  {
    const tooClose = daysToExpiry < MIN_DAYS_TO_EXPIRY;
    add({
      id: 'expiry_distance', label: 'Enough time to expiry for the move to play out',
      group: 'volatility', weight: 1.5, gate: true,
      verdict: tooClose ? 'fail' : daysToExpiry <= 3 ? 'fail' : 'pass',
      observed: daysToExpiry === 0
        ? 'Expiry day — theta and gamma dominate; no fresh option buys'
        : `${daysToExpiry} calendar day(s) to ${chain.expiry}${daysToExpiry <= 3 && !tooClose ? ' — short; the underlying must move soon or the premium decays' : ''}`,
    });
  }

  // ── pricing and sizing, from the setup engine ─────────────────────────────

  const setup = buildOptionSetup({
    underlying, chain, signal: daily.report, atr: daily.snapshot.volatility.atr14,
    capital, riskPercent, atrStopMultiple, minRewardRisk, now,
  });

  // ── risk ──────────────────────────────────────────────────────────────────

  {
    const priced = setup.action !== 'NO_TRADE';
    add({
      id: 'contract_priced_and_sized', label: 'A contract can be priced, stopped and sized',
      group: 'risk', weight: 2, gate: true,
      verdict: bias === 'NEUTRAL' ? 'na' : priced ? 'pass' : 'fail',
      observed: priced
        ? `${setup.strike} ${setup.optionType} near ₹${fmt(setup.entryPremium)}, ${setup.sizing?.lots ?? 0} lot(s)`
        : setup.rejectedBecause[0] ?? 'The setup engine declined the trade',
    });
  }

  {
    const dies = setup.warnings.some((w) => w.includes('worthless before the underlying stop'));
    add({
      id: 'survives_to_stop', label: 'The option survives to the underlying stop',
      group: 'risk', weight: 2,
      verdict: setup.action === 'NO_TRADE' ? 'na' : dies ? 'fail' : 'pass',
      observed: setup.action === 'NO_TRADE'
        ? 'No priced contract'
        : dies
          ? 'The adverse move to the stop costs most of the premium — the stop is nominal and the whole outlay is the real risk'
          : `Stop ₹${fmt(setup.stopPremium)} against entry ₹${fmt(setup.entryPremium)} at delta ${fmt(setup.delta, 2)}`,
    });
  }

  {
    const share = setup.totalPremiumAtRisk !== null && capital > 0 ? setup.totalPremiumAtRisk / capital : null;
    add({
      id: 'outlay_share', label: 'Premium outlay is a sane share of capital',
      group: 'risk', weight: 1,
      verdict: share === null ? 'na' : share <= OUTLAY_SHARE_WARN ? 'pass' : 'fail',
      observed: share === null
        ? 'No sized position'
        : `₹${fmt(setup.totalPremiumAtRisk, 0)} is ${(share * 100).toFixed(1)}% of ₹${capital.toFixed(0)}${share > OUTLAY_SHARE_WARN ? ' — a gap through the stop loses all of it' : ''}`,
    });
  }

  {
    const spreadItem = setup.evidence.find((e) => e.label === 'Bid-ask spread');
    const spreadPct = spreadItem ? Number.parseFloat(spreadItem.value) : null;
    const oiItem = setup.evidence.find((e) => e.label === 'Open interest');
    const tight = spreadPct !== null && Number.isFinite(spreadPct) && spreadPct <= 5;
    add({
      id: 'liquidity', label: 'The strike is liquid enough to exit',
      group: 'risk', weight: 1,
      verdict: setup.action === 'NO_TRADE' ? 'na' : tight && oiItem ? 'pass' : 'fail',
      observed: setup.action === 'NO_TRADE'
        ? 'No priced contract'
        : `${spreadItem ? `Spread ${spreadItem.value}` : 'No two-sided quote'}${oiItem ? `, OI ${oiItem.value}` : ', no open interest'}`,
    });
  }

  // ── score, coverage, gates, grade ─────────────────────────────────────────

  const evaluable = factors.filter((f) => f.verdict !== 'na');
  const totalWeight = factors.reduce((s, f) => s + f.weight, 0);
  const possible = evaluable.reduce((s, f) => s + f.weight, 0);
  const achieved = evaluable.filter((f) => f.verdict === 'pass').reduce((s, f) => s + f.weight, 0);
  const score = possible > 0 ? Math.round((achieved / possible) * 100) : 0;
  const coverage = totalWeight > 0 ? possible / totalWeight : 0;

  const gatesFailed = factors
    .filter((f) => f.gate && f.verdict === 'fail')
    .map((f) => `${f.label}: ${f.observed}`);

  const structureOk = factors.find((f) => f.id === 'structure_agrees')?.verdict !== 'fail';
  const timingFail = factors.some(
    (f) => f.group === 'timing' && f.weight >= 2 && f.verdict === 'fail',
  );

  let grade: Grade;
  if (gatesFailed.length > 0 || bias === 'NEUTRAL' || setup.action === 'NO_TRADE') grade = 'NONE';
  else if (score >= GRADE_A_SCORE && structureOk && !timingFail) grade = 'A';
  else if (score >= GRADE_B_SCORE) grade = 'B';
  else if (score >= GRADE_C_SCORE) grade = 'C';
  else grade = 'NONE';

  const holdBecause: string[] = [];
  if (grade !== 'NONE' && coverage < MIN_COVERAGE_FOR_ENTRY) {
    holdBecause.push(
      `Only ${(coverage * 100).toFixed(0)}% of the checklist could be evaluated — too little of the picture is readable to act on.`,
    );
    if (grade === 'A' || grade === 'B') grade = 'C';
  }

  const stance: Stance = grade === 'A' || grade === 'B' ? 'ENTER' : grade === 'C' ? 'WAIT' : 'AVOID';

  if (stance !== 'ENTER') {
    for (const g of gatesFailed) holdBecause.push(g);
    if (bias === 'NEUTRAL' && dailyScore !== null) {
      holdBecause.push(`The ${daily.snapshot.timeframe} score of ${dailyScore.toFixed(0)} gives no direction to trade.`);
    }
    if (setup.action === 'NO_TRADE' && bias !== 'NEUTRAL') {
      for (const r of setup.rejectedBecause) holdBecause.push(r);
    }
    if (grade === 'C') {
      const failing = evaluable.filter((f) => f.verdict === 'fail').map((f) => f.label.toLowerCase());
      holdBecause.push(
        `${score}/100 of the readable checklist agrees, below the ${GRADE_B_SCORE} needed to act` +
        (failing.length ? `; still against it: ${failing.slice(0, 4).join(', ')}.` : '.'),
      );
    } else if (grade === 'NONE' && gatesFailed.length === 0 && bias !== 'NEUTRAL' && setup.action !== 'NO_TRADE') {
      holdBecause.push(`Only ${score}/100 of the readable checklist agrees.`);
    }
  }

  // ── plan ──────────────────────────────────────────────────────────────────

  let plan: TradePlan | null = null;
  if (
    setup.action !== 'NO_TRADE' && setup.entryPremium !== null && setup.stopPremium !== null
    && setup.targetPremium !== null && setup.underlyingStop !== null && setup.underlyingTarget !== null
    && setup.spot !== null && setup.delta !== null && setup.sizing
  ) {
    const stopDistance = Math.abs(setup.spot - setup.underlyingStop);
    const target2Underlying = bull
      ? setup.spot + stopDistance * TARGET2_R
      : setup.spot - stopDistance * TARGET2_R;
    const target2Premium = setup.entryPremium + stopDistance * TARGET2_R * Math.abs(setup.delta);
    const riskPerUnit = setup.entryPremium - setup.stopPremium;

    // A limit inside the quoted spread; without a book, one percent either side.
    const spreadItem = setup.evidence.find((e) => e.label === 'Bid-ask spread');
    const spreadPct = spreadItem ? Number.parseFloat(spreadItem.value) / 100 : 0.01;
    const half = setup.entryPremium * (Number.isFinite(spreadPct) ? spreadPct : 0.01) / 2;

    const shortDated = daysToExpiry <= 3;
    plan = {
      entryPremium: setup.entryPremium,
      entryZone: {
        low: Number((setup.entryPremium - half).toFixed(2)),
        high: Number((setup.entryPremium + half).toFixed(2)),
      },
      stopPremium: setup.stopPremium,
      target1Premium: setup.targetPremium,
      target2Premium: Number(target2Premium.toFixed(2)),
      underlyingEntry: setup.spot,
      underlyingStop: setup.underlyingStop,
      underlyingTarget1: setup.underlyingTarget,
      underlyingTarget2: Number(target2Underlying.toFixed(2)),
      rewardRisk1: setup.rewardRisk,
      rewardRisk2: riskPerUnit > 0 ? Number(((target2Premium - setup.entryPremium) / riskPerUnit).toFixed(2)) : null,
      lots: setup.sizing.lots ?? 0,
      quantity: setup.sizing.quantity,
      premiumOutlay: setup.totalPremiumAtRisk ?? setup.entryPremium * setup.sizing.quantity,
      riskAtStop: setup.sizing.actualCapitalAtRisk,
      timeStop: shortDated
        ? 'Exit by 15:15 IST today if neither level has been hit. With this little time to expiry, a position carried overnight at a loss is mostly theta.'
        : `If ${underlying} has not moved in your favour within two sessions, exit. Theta is then paying for a view that is not playing out.`,
      exitRules: [
        `Stop: exit the whole position if the premium trades at or below ₹${setup.stopPremium.toFixed(2)}, or if ${underlying} trades through ${setup.underlyingStop.toFixed(0)} — whichever comes first. The stop on the premium is nominal; the underlying level is the real invalidation.`,
        `Target 1 at ₹${setup.targetPremium.toFixed(2)} (${underlying} ${setup.underlyingTarget.toFixed(0)}): book half and move the stop on the rest to your entry price.`,
        `Target 2 at ₹${target2Premium.toFixed(2)} (${underlying} ${target2Underlying.toFixed(0)}): close the remainder, or trail it behind the ${intraday?.snapshot.timeframe ?? '15m'} Supertrend if the move is still extending.`,
        shortDated
          ? 'Time stop: flat by 15:15 IST today if neither level is hit.'
          : 'Time stop: flat within two sessions if the underlying has not progressed.',
        `Thesis stop: exit if the ${daily.snapshot.timeframe} rule score crosses back through 50 — the reason for the trade is gone even if the stop is not hit.`,
      ],
    };
  }

  // ── what would change the read ────────────────────────────────────────────

  const whatChangesMyMind: string[] = [];
  if (bias !== 'NEUTRAL') {
    if (setup.underlyingStop !== null) {
      whatChangesMyMind.push(`${underlying} trading through ${setup.underlyingStop.toFixed(0)}.`);
    }
    if (intraday?.snapshot.vwap != null) {
      whatChangesMyMind.push(
        `A ${intraday.snapshot.timeframe} close ${bull ? 'below' : 'above'} session VWAP (${intraday.snapshot.vwap.toFixed(2)}).`,
      );
    }
    whatChangesMyMind.push(`The ${daily.snapshot.timeframe} rule score crossing back through 50 (now ${fmt(dailyScore, 0)}).`);
    if (pcr.pcrOi !== null) {
      whatChangesMyMind.push(`PCR crossing ${bull ? 'below' : 'above'} 1.0 (now ${pcr.pcrOi.toFixed(2)}).`);
    }
    if (shift.callOiChange !== 0 || shift.putOiChange !== 0) {
      whatChangesMyMind.push(
        `${bull ? 'Call' : 'Put'} writers adding faster than ${bull ? 'put' : 'call'} writers over the next chain refresh.`,
      );
    }
  }

  // ── summary ───────────────────────────────────────────────────────────────

  const passing = evaluable.filter((f) => f.verdict === 'pass').length;
  const contract = setup.strike !== null && setup.optionType
    ? `${underlying} ${setup.strike} ${setup.optionType}`
    : underlying;
  let summary: string;
  if (stance === 'ENTER' && plan) {
    summary =
      `Grade ${grade}: ${passing} of ${evaluable.length} readable conditions agree on a ${bias.toLowerCase()} view. ` +
      `Buy ${plan.lots} lot(s) of ${contract} between ₹${plan.entryZone.low.toFixed(2)} and ₹${plan.entryZone.high.toFixed(2)}; ` +
      `stop ₹${plan.stopPremium.toFixed(2)} / ${underlying} ${plan.underlyingStop.toFixed(0)}; ` +
      `targets ₹${plan.target1Premium.toFixed(2)} and ₹${plan.target2Premium.toFixed(2)}. ` +
      `The grade counts agreeing conditions; it is not a probability, and the full ₹${plan.premiumOutlay.toFixed(0)} premium can be lost.` +
      (entryWindowOpen ? '' : ' Wait for the entry window before acting.');
  } else if (stance === 'WAIT') {
    summary =
      `Grade C — wait. The ${bias.toLowerCase()} read is there but only ${score}/100 of the readable checklist supports acting on it now. ` +
      `The plan below shows what the trade would look like if the missing conditions fall into place.`;
  } else {
    summary = `No trade. ${holdBecause[0] ?? 'The checklist does not support a directional option buy right now.'}`;
  }

  return {
    underlying,
    expiry: chain.expiry,
    daysToExpiry,
    bias,
    stance,
    grade,
    action: stance === 'ENTER' ? setup.action : 'NO_TRADE',
    score,
    coverage: Math.round(coverage * 100),
    factors,
    gatesFailed,
    entryWindowOpen,
    sessionNote,
    // The setup engine's own confirmation counted a narrower set of
    // conditions; downstream thresholds (paper trading, alerts) compare
    // against the checklist score instead so one number means one thing.
    setup: { ...setup, confirmation: score },
    plan,
    whatChangesMyMind,
    summary,
    holdBecause,
  };
}

/** Numeric rank, so "at least grade B" is a comparison. */
export const GRADE_RANK: Record<Grade, number> = { A: 3, B: 2, C: 1, NONE: 0 };

export const meetsGrade = (grade: Grade, minimum: Grade): boolean =>
  GRADE_RANK[grade] >= GRADE_RANK[minimum];
