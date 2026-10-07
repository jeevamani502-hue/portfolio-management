/**
 * F&O decision service — gathers every input the decision engine wants,
 * runs it, and keeps the journal.
 *
 * The engine itself is pure. This is the part that knows where the inputs
 * live: the daily and intraday candle stores, the option chain and its
 * analytics, the regime detector, India VIX, and the clock. Each is fetched
 * with the user's own provider credentials, and each is allowed to be
 * missing — the engine reads what it can and reports its coverage.
 *
 * Every ENTER-grade decision is written to the signal journal exactly once
 * per active contract, so the same setup re-evaluated every thirty seconds
 * by an alert does not become thirty entries in the track record.
 */
import { query, queryRows, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getCandles, getQuotes, marketStatus } from '../market/marketData.service.js';
import { getRegime } from '../market/market.service.js';
import { getExpiries, getOptionChain, getOptionAnalytics, underlyingInstrumentFor } from '../options/options.service.js';
import { isAvailable, sourced, unavailable, type Sourced } from '../../utils/sourced.js';
import { toIst, type Timeframe } from '../../utils/time.js';
import { buildSnapshot, InsufficientHistoryError } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import {
  buildFnoDecision, calendarDaysToExpiry, MIN_DAYS_TO_EXPIRY,
  type FnoDecision, type TimeframeView,
} from '../../analysis/options/decisionEngine.js';
import {
  summariseByGrade, type GradeStats, type SignalStatus,
} from '../../analysis/options/signalOutcome.js';

const log = logger.child({ module: 'fno' });

export type SignalOrigin = 'alert' | 'paper' | 'manual' | 'live';

export interface EvaluateOptions {
  capital: number;
  riskPercent: number;
  /** YYYY-MM-DD; when omitted the nearest expiry with enough time left is used. */
  expiry?: string;
  /** Higher timeframe that sets the bias. */
  biasTimeframe?: '1h' | '1d';
  /** Lower timeframe that times the entry. */
  entryTimeframe?: '5m' | '15m' | '1h';
  atrStopMultiple?: number;
  minRewardRisk?: number;
  /** Write an ENTER-grade decision to the journal under this origin. */
  record?: { userId: string; origin: SignalOrigin } | null;
}

export interface FnoEvaluation {
  result: Sourced<FnoDecision>;
  expiry: string | null;
  underlyingSymbol: string;
  /** Journal row for this contract, when the decision was recorded. */
  signalId: number | null;
  /** True when this call created the journal row (not a repeat of an active one). */
  isNewSignal: boolean;
}

/**
 * The nearest expiry that still has enough time for a directional buy.
 *
 * On a Wednesday with a Thursday expiry, the "nearest" chain is the one an
 * option buyer should not be in; a trader rolls to the next week. When no
 * expiry qualifies the nearest is returned and the engine's own gate says why.
 */
export function pickExpiry(expiries: readonly string[], now: Date): string | null {
  if (expiries.length === 0) return null;
  const usable = expiries.find((e) => calendarDaysToExpiry(e, now) >= MIN_DAYS_TO_EXPIRY);
  return usable ?? expiries[0]!;
}

async function timeframeView(
  registry: ProviderRegistry,
  instrument: instrumentsRepo.InstrumentRow,
  timeframe: Timeframe,
  bars: number,
): Promise<{ view: TimeframeView | null; source: string | null; error: string | null }> {
  try {
    const candles = await getCandles(registry, instrument, timeframe, { bars });
    if (candles.candles.length < 30) {
      return { view: null, source: candles.source, error: `only ${candles.candles.length} ${timeframe} bars` };
    }
    const snapshot = buildSnapshot(instrument.tradingsymbol, timeframe, candles.candles);
    return { view: { snapshot, report: runSignalEngine(snapshot) }, source: candles.source, error: null };
  } catch (err) {
    if (err instanceof InsufficientHistoryError) {
      return { view: null, source: null, error: err.message };
    }
    return { view: null, source: null, error: err instanceof Error ? err.message : 'history unavailable' };
  }
}

export async function evaluateUnderlying(
  registry: ProviderRegistry,
  underlying: string,
  opts: EvaluateOptions,
): Promise<FnoEvaluation> {
  const sym = underlying.toUpperCase();
  const underlyingSymbol = underlyingInstrumentFor(sym);
  const now = new Date();
  const fail = (result: Sourced<FnoDecision>, expiry: string | null = null): FnoEvaluation =>
    ({ result, expiry, underlyingSymbol, signalId: null, isNewSignal: false });

  // ── expiry and chain ──────────────────────────────────────────────────────
  let expiry = opts.expiry ?? null;
  if (!expiry) {
    const expiries = await getExpiries(registry, sym);
    if (!isAvailable(expiries) || expiries.value.length === 0) {
      return fail(unavailable(
        'no_expiries',
        `No option expiries are listed for ${sym}. Run the instruments sync, or configure a provider with option-chain support.`,
        undefined, 'rule_signal',
      ));
    }
    expiry = pickExpiry(expiries.value, now);
  }
  if (!expiry) return fail(unavailable('no_expiries', `No expiry available for ${sym}.`, undefined, 'rule_signal'));

  const chain = await getOptionChain(registry, sym, expiry);
  if (!isAvailable(chain)) {
    return fail({ ...chain, kind: 'rule_signal' }, expiry);
  }

  // ── the underlying's history, on both timeframes ─────────────────────────
  const instrument = await instrumentsRepo.resolveSymbol(underlyingSymbol);
  if (!instrument) {
    return fail(unavailable(
      'underlying_not_found',
      `Cannot score ${sym}: its underlying "${underlyingSymbol}" is not in the instrument master.`,
      undefined, 'rule_signal',
    ), expiry);
  }

  const biasTf: Timeframe = opts.biasTimeframe ?? '1d';
  const entryTf: Timeframe = opts.entryTimeframe ?? '15m';
  const [daily, intraday] = await Promise.all([
    timeframeView(registry, instrument, biasTf, 300),
    timeframeView(registry, instrument, entryTf, 300),
  ]);

  if (!daily.view) {
    return fail(unavailable(
      'insufficient_history',
      `No usable ${biasTf} price history for ${underlyingSymbol}${daily.error ? ` (${daily.error})` : ''}, so no direction can be established.`,
      undefined, 'rule_signal',
    ), expiry);
  }
  if (!intraday.view) {
    log.debug({ sym, entryTf, reason: intraday.error }, 'Intraday view unavailable; timing factors will be unreadable');
  }

  // ── context: regime, VIX, IV percentile, the clock ───────────────────────
  const [regime, vix, analytics, status] = await Promise.all([
    getRegime(registry).catch(() => null),
    loadVix(registry),
    getOptionAnalytics(registry, sym, expiry).catch(() => null),
    marketStatus(),
  ]);

  const decision = buildFnoDecision({
    underlying: sym,
    chain: chain.value,
    daily: daily.view,
    intraday: intraday.view,
    regime: regime && isAvailable(regime) ? regime.value : null,
    vix,
    ivPercentile: analytics && isAvailable(analytics) ? analytics.value.ivPercentile.percentile : null,
    market: { phase: status.phase, minutesOfDay: toIst(now).minutesOfDay },
    capital: opts.capital,
    riskPercent: opts.riskPercent,
    ...(opts.atrStopMultiple !== undefined ? { atrStopMultiple: opts.atrStopMultiple } : {}),
    ...(opts.minRewardRisk !== undefined ? { minRewardRisk: opts.minRewardRisk } : {}),
    now,
  });

  // ── journal ───────────────────────────────────────────────────────────────
  // Only inside the entry window. A plan built on the last close at 8 pm is
  // still shown, but journaling it would score it against the next morning's
  // gap — a record of trades nobody could have taken.
  let signalId: number | null = null;
  let isNewSignal = false;
  if (opts.record && decision.stance === 'ENTER' && decision.plan && decision.entryWindowOpen) {
    try {
      const rec = await recordSignal(
        opts.record.userId, opts.record.origin, decision, chain.source, chain.asOf,
        registry.candidates('quote').map((p) => p.manifest.id),
      );
      signalId = rec.id;
      isNewSignal = rec.isNew;
    } catch (err) {
      log.warn({ err, sym }, 'Signal not journaled');
    }
  }

  return {
    result: sourced(decision, {
      source: chain.source,
      asOf: chain.asOf,
      freshness: 'optionChain',
      kind: 'rule_signal',
      marketOpen: status.isSessionActive,
    }),
    expiry,
    underlyingSymbol,
    signalId,
    isNewSignal,
  };
}

async function loadVix(registry: ProviderRegistry): Promise<number | null> {
  try {
    const row = await instrumentsRepo.resolveSymbol('INDIA VIX');
    if (!row) return null;
    const quotes = await getQuotes(registry, [row]);
    const q = quotes.get(row.id);
    return q && isAvailable(q) ? q.value.ltp : null;
  } catch {
    return null;
  }
}

// ── journal ─────────────────────────────────────────────────────────────────

async function recordSignal(
  userId: string,
  origin: SignalOrigin,
  d: FnoDecision,
  source: string,
  dataAsOf: string,
  /** Provider order the tracker will quote with, so the row it links can be priced. */
  prefer: readonly string[],
): Promise<{ id: number; isNew: boolean }> {
  const plan = d.plan!;
  const strike = d.setup.strike!;
  const optionType = d.setup.optionType!;
  const contract = await instrumentsRepo.findOptionContract(d.underlying, d.expiry, strike, optionType, prefer);

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO fno_signals
       (user_id, underlying, expiry, strike, option_type, instrument_id, tradingsymbol,
        action, grade, score, timeframe, spot, entry_premium, stop_premium, target1_premium,
        target2_premium, underlying_stop, underlying_target1, underlying_target2,
        factors, plan, source, data_as_of, origin)
     VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20::jsonb,$21::jsonb,$22,$23,$24)
     ON CONFLICT (user_id, underlying, expiry, strike, option_type) WHERE status = 'ACTIVE'
     DO NOTHING
     RETURNING id`,
    [
      userId, d.underlying, d.expiry, strike, optionType, contract?.id ?? null,
      contract?.tradingsymbol ?? null, d.action, d.grade, d.score, '1d', plan.underlyingEntry,
      plan.entryPremium, plan.stopPremium, plan.target1Premium, plan.target2Premium,
      plan.underlyingStop, plan.underlyingTarget1, plan.underlyingTarget2,
      JSON.stringify(d.factors), JSON.stringify(plan), source, dataAsOf, origin,
    ],
  );
  if (inserted) {
    log.info({ userId, contract: `${d.underlying} ${strike} ${optionType}`, grade: d.grade, origin }, 'Signal journaled');
    return { id: Number(inserted.id), isNew: true };
  }

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM fno_signals
      WHERE user_id = $1 AND underlying = $2 AND expiry = $3::date
        AND strike = $4 AND option_type = $5 AND status = 'ACTIVE'`,
    [userId, d.underlying, d.expiry, strike, optionType],
  );
  return { id: Number(existing?.id ?? 0), isNew: false };
}

export interface SignalView {
  id: number;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  tradingsymbol: string | null;
  action: 'BUY_CALL' | 'BUY_PUT';
  grade: 'A' | 'B' | 'C';
  score: number;
  spot: number;
  entryPremium: number;
  stopPremium: number;
  target1Premium: number;
  target2Premium: number | null;
  underlyingStop: number;
  underlyingTarget1: number;
  underlyingTarget2: number | null;
  origin: SignalOrigin;
  status: SignalStatus;
  lastPremium: number | null;
  maxFavourablePremium: number | null;
  maxAdversePremium: number | null;
  rMultiple: number | null;
  notes: string | null;
  generatedAt: string;
  lastCheckedAt: string | null;
  resolvedAt: string | null;
  source: string;
  dataAsOf: string;
}

interface SignalRow {
  id: string; underlying: string; expiry: string; strike: string; option_type: 'CE' | 'PE';
  tradingsymbol: string | null; action: 'BUY_CALL' | 'BUY_PUT'; grade: 'A' | 'B' | 'C';
  score: number; spot: string; entry_premium: string; stop_premium: string;
  target1_premium: string; target2_premium: string | null; underlying_stop: string;
  underlying_target1: string; underlying_target2: string | null; origin: SignalOrigin;
  status: SignalStatus; last_premium: string | null; max_favourable_premium: string | null;
  max_adverse_premium: string | null; r_multiple: string | null; notes: string | null;
  generated_at: Date; last_checked_at: Date | null; resolved_at: Date | null;
  source: string; data_as_of: Date;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

const toView = (r: SignalRow): SignalView => ({
  id: Number(r.id),
  underlying: r.underlying,
  expiry: r.expiry,
  strike: Number(r.strike),
  optionType: r.option_type,
  tradingsymbol: r.tradingsymbol,
  action: r.action,
  grade: r.grade,
  score: r.score,
  spot: Number(r.spot),
  entryPremium: Number(r.entry_premium),
  stopPremium: Number(r.stop_premium),
  target1Premium: Number(r.target1_premium),
  target2Premium: num(r.target2_premium),
  underlyingStop: Number(r.underlying_stop),
  underlyingTarget1: Number(r.underlying_target1),
  underlyingTarget2: num(r.underlying_target2),
  origin: r.origin,
  status: r.status,
  lastPremium: num(r.last_premium),
  maxFavourablePremium: num(r.max_favourable_premium),
  maxAdversePremium: num(r.max_adverse_premium),
  rMultiple: num(r.r_multiple),
  notes: r.notes,
  generatedAt: r.generated_at.toISOString(),
  lastCheckedAt: r.last_checked_at?.toISOString() ?? null,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  source: r.source,
  dataAsOf: r.data_as_of.toISOString(),
});

const SIGNAL_SELECT = `
  id, underlying, to_char(expiry, 'YYYY-MM-DD') AS expiry, strike, option_type, tradingsymbol,
  action, grade, score, spot, entry_premium, stop_premium, target1_premium, target2_premium,
  underlying_stop, underlying_target1, underlying_target2, origin, status, last_premium,
  max_favourable_premium, max_adverse_premium, r_multiple, notes, generated_at,
  last_checked_at, resolved_at, source, data_as_of`;

export async function listSignals(
  userId: string,
  opts: { status?: 'ACTIVE' | 'RESOLVED'; underlying?: string; limit?: number } = {},
): Promise<SignalView[]> {
  const rows = await queryRows<SignalRow>(
    `SELECT ${SIGNAL_SELECT} FROM fno_signals
      WHERE user_id = $1
        AND ($2::text IS NULL OR ($2 = 'ACTIVE' AND status = 'ACTIVE') OR ($2 = 'RESOLVED' AND status <> 'ACTIVE'))
        AND ($3::text IS NULL OR underlying = $3)
      ORDER BY generated_at DESC
      LIMIT $4`,
    [userId, opts.status ?? null, opts.underlying?.toUpperCase() ?? null, Math.min(opts.limit ?? 50, 500)],
  );
  return rows.map(toView);
}

export interface SignalPerformance {
  byGrade: GradeStats[];
  issued: number;
  resolved: number;
  sinceDays: number;
  /** What the numbers do and do not establish, in plain words. */
  caveat: string;
  method: string;
}

export async function signalPerformance(userId: string, sinceDays = 90): Promise<SignalPerformance> {
  const rows = await queryRows<{
    grade: string; status: SignalStatus; r_multiple: string | null;
    entry_premium: string; stop_premium: string; max_favourable_premium: string | null;
  }>(
    `SELECT grade, status, r_multiple, entry_premium, stop_premium, max_favourable_premium
       FROM fno_signals
      WHERE user_id = $1 AND generated_at > now() - ($2::int * INTERVAL '1 day')`,
    [userId, sinceDays],
  );

  const records = rows.map((r) => ({
    grade: r.grade,
    status: r.status,
    rMultiple: num(r.r_multiple),
    entryPremium: Number(r.entry_premium),
    stopPremium: Number(r.stop_premium),
    maxFavourablePremium: num(r.max_favourable_premium),
  }));
  const byGrade = summariseByGrade(records);
  const resolved = records.filter((r) => r.status !== 'ACTIVE').length;

  return {
    byGrade,
    issued: records.length,
    resolved,
    sinceDays,
    caveat:
      resolved < 30
        ? `Only ${resolved} signal(s) have resolved. At this sample size the spread of possible hit rates is ` +
          'far wider than any difference between grades, so treat these figures as a log, not a verdict.'
        : 'Outcomes are resolved from quotes at one-minute checks and assume a fill at the observed price. ' +
          'A live position faces slippage, gaps through the stop and the cost stack, so realised results run below these.',
    method:
      'Every ENTER-grade signal is journaled with its plan at issue. A tracker checks each active signal against ' +
      'the contract\'s quote and the underlying\'s spot: stop or invalidation first, then targets, then expiry ' +
      'and the time stop. R is the move from entry in multiples of the premium risked to the stop.',
  };
}

/** For the tracker: every active signal, with what it needs to price itself. */
export async function activeSignals(): Promise<Array<SignalView & { userId: string; instrumentId: number | null; stopWarned: boolean; expiryWarned: boolean }>> {
  const rows = await queryRows<SignalRow & { user_id: string; instrument_id: string | null; stop_warned: boolean; expiry_warned: boolean }>(
    `SELECT ${SIGNAL_SELECT}, user_id, instrument_id, stop_warned, expiry_warned
       FROM fno_signals WHERE status = 'ACTIVE' ORDER BY user_id, generated_at`,
  );
  return rows.map((r) => ({
    ...toView(r),
    userId: r.user_id,
    instrumentId: r.instrument_id === null ? null : Number(r.instrument_id),
    stopWarned: r.stop_warned,
    expiryWarned: r.expiry_warned,
  }));
}

/**
 * Point a journal entry at a different row for the same contract.
 *
 * Used when the row linked at issue carries no token any configured broker
 * can quote — the other spelling of the same strike does.
 */
export async function relinkSignalContract(
  id: number,
  contract: { id: number; tradingsymbol: string },
): Promise<void> {
  await query(
    `UPDATE fno_signals SET instrument_id = $2, tradingsymbol = $3 WHERE id = $1`,
    [id, contract.id, contract.tradingsymbol],
  );
}

export async function updateSignalObservation(
  id: number,
  update: {
    lastPremium: number; maxFavourablePremium: number; maxAdversePremium: number;
    status: SignalStatus; rMultiple: number | null; note: string;
    stopWarned?: boolean; expiryWarned?: boolean;
  },
): Promise<void> {
  const resolved = update.status !== 'ACTIVE';
  await query(
    `UPDATE fno_signals SET
       last_premium = $2, max_favourable_premium = $3, max_adverse_premium = $4,
       last_checked_at = now(),
       status = $5,
       r_multiple = CASE WHEN $6::boolean THEN $7 ELSE r_multiple END,
       resolved_at = CASE WHEN $6::boolean THEN now() ELSE resolved_at END,
       resolved_premium = CASE WHEN $6::boolean THEN $2 ELSE resolved_premium END,
       notes = $8,
       stop_warned = COALESCE($9::boolean, stop_warned),
       expiry_warned = COALESCE($10::boolean, expiry_warned)
     WHERE id = $1`,
    [
      id, update.lastPremium, update.maxFavourablePremium, update.maxAdversePremium,
      update.status, resolved, update.rMultiple, update.note,
      update.stopWarned ?? null, update.expiryWarned ?? null,
    ],
  );
}
