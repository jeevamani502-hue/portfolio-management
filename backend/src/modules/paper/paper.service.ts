/**
 * Paper trading — a simulated ledger, so a strategy can be judged before any
 * money is committed to it.
 *
 * There is no broker in this file and no way to reach one. Fills are derived
 * from real quotes; the only thing invented is the assumption that an order
 * of this size would have filled at all.
 *
 * The simulation is deliberately unkind to itself:
 *
 *   · entries cross the spread and pay slippage on top, because the mid is
 *     not a price anyone gets;
 *   · exits cross the spread the other way;
 *   · the full Indian cost stack (brokerage, STT, exchange, SEBI, GST, stamp
 *     duty) is charged on both legs;
 *   · a stop and a target hit in the same bar resolve as the stop.
 *
 * Every one of those makes the reported edge smaller. That is the point: a
 * paper result that flatters the strategy is worse than no result, because
 * it invites real money on a false premise.
 */
import { query, queryRows, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import type { InstrumentRow } from '../../db/repositories/instruments.js';
import { getQuote } from '../market/marketData.service.js';
import { getJson } from '../../cache/redis.js';
import { K } from '../../cache/keys.js';
import { isAvailable } from '../../utils/sourced.js';
import { calculateRoundTripCosts, type Segment } from '../../analysis/backtest/costs.js';
import { evaluateUnderlying } from '../fno/fno.service.js';
import { notify } from '../notifications/notifications.service.js';
import { intradayEntryBlock, squareOffDue } from '../../analysis/paper/intradayRules.js';
import { decideDirectionExit, DEFAULT_GUARD } from '../../analysis/options/directionGuard.js';
import { meetsGrade } from '../../analysis/options/decisionEngine.js';
import { readDirection } from '../market/directionRead.js';
import { underlyingInstrumentFor } from '../options/options.service.js';

const log = logger.child({ module: 'paper' });

/**
 * Slippage charged on every simulated fill, in basis points.
 *
 * Index options routinely slip more than this on a fast move; equities less.
 * Fifteen is a deliberately unflattering middle, chosen so the simulation
 * does not quietly assume the best case.
 */
const SLIPPAGE_BPS = 15;

export interface PaperConfig {
  user_id: string;
  is_enabled: boolean;
  capital: string;
  risk_per_trade_pct: string;
  max_open_positions: number;
  max_trades_per_day: number;
  max_daily_loss_pct: string;
  min_confirmation: number;
  underlyings: string[];
  trade_options: boolean;
  trade_equity: boolean;
  intraday_only: boolean;
  entry_cutoff_min: number;
  square_off_min: number;
  direction_guard: boolean;
  entry_start_min: number;
  min_grade: 'A' | 'B' | 'C';
  require_timing_agreement: boolean;
  require_named_setup: boolean;
  reentry_cooldown_min: number;
  cut_loser_at_r: string;
  stop_atr_multiple: string;
  target1_r: string;
  target2_r: string;
  halted_reason: string | null;
  halted_at: Date | null;
}

const intradayCfg = (c: PaperConfig) => ({
  intradayOnly: c.intraday_only, entryCutoffMin: c.entry_cutoff_min, squareOffMin: c.square_off_min,
});

export interface PaperTradeRow {
  id: string;
  user_id: string;
  tradingsymbol: string;
  exchange: string;
  underlying: string | null;
  kind: 'EQUITY' | 'OPTION';
  side: 'BUY' | 'SELL';
  quantity: number;
  lot_size: number | null;
  entry_price: string;
  entry_at: Date;
  stop_price: string | null;
  target_price: string | null;
  underlying_stop: string | null;
  confirmation: number | null;
  rationale: string | null;
  status: 'OPEN' | 'CLOSED';
  exit_price: string | null;
  exit_at: Date | null;
  exit_reason: string | null;
  max_favourable_premium: string | null;
  gross_pnl: string | null;
  costs: string | null;
  net_pnl: string | null;
  instrument_id: number | null;
}

const n = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

// ── fill simulation ─────────────────────────────────────────────────────────

interface Fill {
  price: number;
  reference: number;
}

/**
 * Simulate a fill from a live quote.
 *
 * Returns null rather than guessing when no price is available — a
 * simulation built on an invented price teaches nothing.
 */
async function simulateFill(
  registry: ProviderRegistry,
  instrument: InstrumentRow,
  side: 'BUY' | 'SELL',
): Promise<Fill | null> {
  const quote = await getQuote(registry, instrument);
  if (!isAvailable(quote)) return null;
  const q = await freshestQuote(instrument.id, quote.value, quote.asOf);

  // Cross the spread where there is a book; fall back to last traded.
  const reference =
    side === 'BUY'
      ? q.ask !== null && q.ask > 0 ? q.ask : q.ltp
      : q.bid !== null && q.bid > 0 ? q.bid : q.ltp;

  if (!(reference > 0)) return null;

  const slip = reference * (SLIPPAGE_BPS / 10_000);
  const price = side === 'BUY' ? reference + slip : reference - slip;
  return { price: Number(price.toFixed(2)), reference };
}

interface QuoteLike { ltp: number; bid: number | null; ask: number | null }

/**
 * The REST quote can be seconds older than the streamed tick the screen is
 * showing. When the stream is fresher, re-base the quote on the streamed
 * last price and carry the REST quote's bid-ask spread across, so a fill
 * is simulated from the price the user was looking at, not an older one.
 */
async function freshestQuote(instrumentId: number, q: QuoteLike, quoteAsOf: string | null | undefined): Promise<QuoteLike> {
  try {
    const tick = await getJson<{ ltp: number; ts: string }>(K.streamTick(instrumentId));
    if (!tick || !(tick.ltp > 0)) return q;
    const tickAt = new Date(tick.ts).getTime();
    const quoteAt = quoteAsOf ? new Date(quoteAsOf).getTime() : 0;
    if (!(tickAt > quoteAt)) return q;
    const halfDown = q.bid !== null && q.bid > 0 ? Math.max(0, q.ltp - q.bid) : 0;
    const halfUp = q.ask !== null && q.ask > 0 ? Math.max(0, q.ask - q.ltp) : 0;
    return { ltp: tick.ltp, bid: tick.ltp - halfDown, ask: tick.ltp + halfUp };
  } catch {
    return q;
  }
}

/** What one open position would make, net, if it were closed this instant. */
export interface OpenMark {
  ltp: number;
  bid: number | null;
  /** The price a sell would be filled at right now: the bid (or last) less slippage. */
  exitPrice: number;
  /** ltp − exitPrice: what crossing the spread and slippage cost, per unit. */
  exitDiscount: number;
  /** Round-trip charges at this exit price. */
  costEstimate: number;
  grossNow: number;
  netIfClosedNow: number;
  asOf: string | null;
}

/**
 * Attach a live "if closed now" mark to every OPEN row. This is the number
 * that matches the figure a close will produce, which the raw last price
 * does not: a sell crosses to the bid, pays slippage, and is charged on both
 * legs. Showing gross on the screen and net in the ledger is how a position
 * can appear to lose most of its profit at the moment it closes.
 */
export async function withOpenMarks(
  registry: ProviderRegistry,
  rows: PaperTradeRow[],
): Promise<Array<PaperTradeRow & { mark: OpenMark | null }>> {
  const out: Array<PaperTradeRow & { mark: OpenMark | null }> = [];
  for (const t of rows) {
    if (t.status !== 'OPEN' || t.instrument_id === null) { out.push({ ...t, mark: null }); continue; }
    try {
      const instrument = await instrumentsRepo.getById(t.instrument_id);
      const quote = instrument ? await getQuote(registry, instrument) : null;
      if (!instrument || !quote || !isAvailable(quote)) { out.push({ ...t, mark: null }); continue; }
      const q = await freshestQuote(instrument.id, quote.value, quote.asOf);
      const reference = q.bid !== null && q.bid > 0 ? q.bid : q.ltp;
      const exitPrice = Number((reference - reference * (SLIPPAGE_BPS / 10_000)).toFixed(2));
      const entry = Number(t.entry_price);
      const segment: Segment = t.kind === 'OPTION' ? 'OPT' : 'EQ_INTRADAY';
      const costs = calculateRoundTripCosts(entry, exitPrice, t.quantity, segment, 'LONG').total;
      const grossNow = (q.ltp - entry) * t.quantity;
      const netIfClosedNow = (exitPrice - entry) * t.quantity - costs;
      out.push({
        ...t,
        mark: {
          ltp: q.ltp, bid: q.bid, exitPrice, exitDiscount: Number((q.ltp - exitPrice).toFixed(2)),
          costEstimate: Number(costs.toFixed(2)), grossNow: Number(grossNow.toFixed(2)),
          netIfClosedNow: Number(netIfClosedNow.toFixed(2)), asOf: quote.asOf ?? null,
        },
      });
    } catch {
      out.push({ ...t, mark: null });
    }
  }
  return out;
}

// ── config ──────────────────────────────────────────────────────────────────

export async function getConfig(userId: string): Promise<PaperConfig | null> {
  return queryOne<PaperConfig>(`SELECT * FROM paper_trade_config WHERE user_id = $1`, [userId]);
}

export async function upsertConfig(
  userId: string,
  patch: Partial<{
    isEnabled: boolean; capital: number; riskPerTradePct: number;
    maxOpenPositions: number; maxTradesPerDay: number; maxDailyLossPct: number;
    minConfirmation: number; underlyings: string[];
    tradeOptions: boolean; tradeEquity: boolean;
    intradayOnly: boolean; entryCutoffMin: number; squareOffMin: number;
    directionGuard: boolean;
    entryStartMin: number; minGrade: 'A' | 'B' | 'C'; requireTimingAgreement: boolean; requireNamedSetup: boolean;
    reentryCooldownMin: number; cutLoserAtR: number; stopAtrMultiple: number; target1R: number; target2R: number;
  }>,
): Promise<PaperConfig> {
  if (patch.entryCutoffMin !== undefined && patch.squareOffMin !== undefined && patch.entryCutoffMin >= patch.squareOffMin) {
    throw new Error('The entry cutoff must be earlier than the square-off time.');
  }
  const existing = await getConfig(userId);

  if (!existing) {
    if (!patch.capital || patch.capital <= 0) {
      throw new Error('Capital is required to start paper trading.');
    }
    await query(
      `INSERT INTO paper_trade_config
         (user_id, is_enabled, capital, risk_per_trade_pct, max_open_positions,
          max_trades_per_day, max_daily_loss_pct, min_confirmation, underlyings,
          trade_options, trade_equity, intraday_only, entry_cutoff_min, square_off_min, direction_guard,
          entry_start_min, min_grade, require_timing_agreement, require_named_setup, reentry_cooldown_min,
          cut_loser_at_r, stop_atr_multiple, target1_r, target2_r)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        userId, patch.isEnabled ?? false, patch.capital, patch.riskPerTradePct ?? 1,
        patch.maxOpenPositions ?? 3, patch.maxTradesPerDay ?? 5, patch.maxDailyLossPct ?? 3,
        patch.minConfirmation ?? 60, patch.underlyings ?? ['NIFTY'],
        patch.tradeOptions ?? true, patch.tradeEquity ?? true,
        patch.intradayOnly ?? true, patch.entryCutoffMin ?? 870, patch.squareOffMin ?? 915,
        patch.directionGuard ?? true,
        patch.entryStartMin ?? 585, patch.minGrade ?? 'B', patch.requireTimingAgreement ?? true, patch.requireNamedSetup ?? false,
        patch.reentryCooldownMin ?? 30, patch.cutLoserAtR ?? 0.5, patch.stopAtrMultiple ?? 1.0, patch.target1R ?? 1.0, patch.target2R ?? 1.5,
      ],
    );
    return (await getConfig(userId))!;
  }

  // Re-enabling clears a halt: the user is explicitly overruling the limit
  // that stopped it, which is their call to make but must be deliberate.
  const clearHalt = patch.isEnabled === true;

  await query(
    `UPDATE paper_trade_config SET
       is_enabled = COALESCE($2, is_enabled),
       capital = COALESCE($3, capital),
       risk_per_trade_pct = COALESCE($4, risk_per_trade_pct),
       max_open_positions = COALESCE($5, max_open_positions),
       max_trades_per_day = COALESCE($6, max_trades_per_day),
       max_daily_loss_pct = COALESCE($7, max_daily_loss_pct),
       min_confirmation = COALESCE($8, min_confirmation),
       underlyings = COALESCE($9, underlyings),
       trade_options = COALESCE($10, trade_options),
       trade_equity = COALESCE($11, trade_equity),
       halted_reason = CASE WHEN $12 THEN NULL ELSE halted_reason END,
       halted_at = CASE WHEN $12 THEN NULL ELSE halted_at END,
       intraday_only = COALESCE($13, intraday_only),
       entry_cutoff_min = COALESCE($14, entry_cutoff_min),
       square_off_min = COALESCE($15, square_off_min),
       direction_guard = COALESCE($16, direction_guard),
       entry_start_min = COALESCE($17, entry_start_min),
       min_grade = COALESCE($18, min_grade),
       require_timing_agreement = COALESCE($19, require_timing_agreement),
       require_named_setup = COALESCE($20, require_named_setup),
       reentry_cooldown_min = COALESCE($21, reentry_cooldown_min),
       cut_loser_at_r = COALESCE($22, cut_loser_at_r),
       stop_atr_multiple = COALESCE($23, stop_atr_multiple),
       target1_r = COALESCE($24, target1_r),
       target2_r = COALESCE($25, target2_r),
       updated_at = now()
     WHERE user_id = $1`,
    [
      userId, patch.isEnabled ?? null, patch.capital ?? null, patch.riskPerTradePct ?? null,
      patch.maxOpenPositions ?? null, patch.maxTradesPerDay ?? null, patch.maxDailyLossPct ?? null,
      patch.minConfirmation ?? null, patch.underlyings ?? null,
      patch.tradeOptions ?? null, patch.tradeEquity ?? null, clearHalt,
      patch.intradayOnly ?? null, patch.entryCutoffMin ?? null, patch.squareOffMin ?? null,
      patch.directionGuard ?? null,
      patch.entryStartMin ?? null, patch.minGrade ?? null, patch.requireTimingAgreement ?? null, patch.requireNamedSetup ?? null,
      patch.reentryCooldownMin ?? null, patch.cutLoserAtR ?? null, patch.stopAtrMultiple ?? null, patch.target1R ?? null, patch.target2R ?? null,
    ],
  );
  return (await getConfig(userId))!;
}

async function halt(userId: string, reason: string): Promise<void> {
  await query(
    `UPDATE paper_trade_config
        SET halted_reason = $2, halted_at = now(), updated_at = now()
      WHERE user_id = $1 AND halted_reason IS NULL`,
    [userId, reason],
  );
  log.warn({ userId, reason }, 'Paper trading halted');
}

// ── limits ──────────────────────────────────────────────────────────────────

interface LimitState {
  openCount: number;
  tradesToday: number;
  netPnlToday: number;
}

async function limitState(userId: string): Promise<LimitState> {
  const row = await queryOne<{ open_count: string; trades_today: string; pnl_today: string | null }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'OPEN')::text AS open_count,
       COUNT(*) FILTER (WHERE entry_at::date = CURRENT_DATE)::text AS trades_today,
       COALESCE(SUM(net_pnl) FILTER (WHERE exit_at::date = CURRENT_DATE), 0)::text AS pnl_today
     FROM paper_trades WHERE user_id = $1`,
    [userId],
  );
  return {
    openCount: Number(row?.open_count ?? 0),
    tradesToday: Number(row?.trades_today ?? 0),
    netPnlToday: Number(row?.pnl_today ?? 0),
  };
}

/**
 * Whether a new entry is allowed, and why not when it is not.
 *
 * The daily-loss check runs first because breaching it halts the strategy
 * rather than merely skipping one trade.
 */
async function entryBlockedBecause(cfg: PaperConfig): Promise<string | null> {
  if (cfg.halted_reason) return `halted: ${cfg.halted_reason}`;
  if (!cfg.is_enabled) return 'paper trading is off';

  const state = await limitState(cfg.user_id);
  const capital = Number(cfg.capital);
  const lossLimit = capital * (Number(cfg.max_daily_loss_pct) / 100);

  if (state.netPnlToday <= -lossLimit) {
    const reason =
      `daily loss limit reached — ₹${Math.abs(state.netPnlToday).toFixed(0)} lost against a ` +
      `₹${lossLimit.toFixed(0)} cap`;
    await halt(cfg.user_id, reason);
    return reason;
  }
  if (state.openCount >= cfg.max_open_positions) {
    return `${state.openCount} positions already open (max ${cfg.max_open_positions})`;
  }
  if (state.tradesToday >= cfg.max_trades_per_day) {
    return `${state.tradesToday} trades already today (max ${cfg.max_trades_per_day})`;
  }
  return intradayEntryBlock(intradayCfg(cfg), new Date());
}

// ── entries ─────────────────────────────────────────────────────────────────

export interface SweepResult {
  considered: number;
  opened: number;
  skipped: string[];
}

/** Look for option setups and open simulated positions in whatever qualifies. */
export async function runEntrySweep(userId: string): Promise<SweepResult> {
  const cfg = await getConfig(userId);
  if (!cfg) return { considered: 0, opened: 0, skipped: ['no paper config'] };

  const blocked = await entryBlockedBecause(cfg);
  if (blocked) return { considered: 0, opened: 0, skipped: [blocked] };

  const registry = await registryForUser(userId);
  const skipped: string[] = [];
  let considered = 0;
  let opened = 0;

  if (!cfg.trade_options) return { considered: 0, opened: 0, skipped: ['options disabled'] };

  for (const underlying of cfg.underlyings) {
    // Re-check between underlyings: an earlier one may have filled the book.
    const stillBlocked = await entryBlockedBecause(cfg);
    if (stillBlocked) { skipped.push(stillBlocked); break; }

    considered += 1;
    try {
      const outcome = await tryOpenOptionTrade(registry, cfg, underlying);
      if (outcome.opened) opened += 1;
      else skipped.push(`${underlying}: ${outcome.reason}`);
    } catch (err) {
      skipped.push(`${underlying}: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`);
    }
  }

  // Record the outcome so the UI can say what the engine decided and why,
  // rather than leaving "running with no trades" indistinguishable from
  // "never ran".
  await query(
    `UPDATE paper_trade_config
        SET last_sweep_at = now(), last_sweep_result = $2::jsonb, updated_at = now()
      WHERE user_id = $1`,
    [userId, JSON.stringify({ considered, opened, skipped })],
  );

  return { considered, opened, skipped };
}

/**
 * The entry decision comes from the F&O decision engine — the same graded
 * checklist the F&O page and the alerts use — so a trade the simulation
 * takes is one the user would have been shown, with the same plan.
 */
async function tryOpenOptionTrade(
  registry: ProviderRegistry,
  cfg: PaperConfig,
  underlying: string,
): Promise<{ opened: boolean; reason: string }> {
  const evaluation = await evaluateUnderlying(registry, underlying, {
    capital: Number(cfg.capital),
    riskPercent: Number(cfg.risk_per_trade_pct),
    horizon: cfg.intraday_only ? 'intraday' : 'swing',
    timingGates: cfg.require_timing_agreement,
    namedSetupGate: cfg.require_named_setup,
    entryStartMin: cfg.entry_start_min,
    atrStopMultiple: Number(cfg.stop_atr_multiple),
    minRewardRisk: Number(cfg.target1_r),
    target2R: Number(cfg.target2_r),
    record: { userId: cfg.user_id, origin: 'paper' },
  });
  if (!isAvailable(evaluation.result) || !evaluation.expiry) {
    const r = evaluation.result;
    return { opened: false, reason: (isAvailable(r) ? null : r.detail ?? r.reason) ?? 'decision unavailable' };
  }
  const decision = evaluation.result.value;
  const expiry = evaluation.expiry;

  if (decision.stance !== 'ENTER' || !decision.plan) {
    return {
      opened: false,
      reason: `grade ${decision.grade} — ${decision.holdBecause[0] ?? 'the checklist does not support an entry'}`,
    };
  }
  if (!decision.entryWindowOpen) {
    return { opened: false, reason: decision.sessionNote };
  }
  if (!meetsGrade(decision.grade, cfg.min_grade)) {
    return { opened: false, reason: `grade ${decision.grade} is below your minimum of ${cfg.min_grade}` };
  }
  if (decision.score < cfg.min_confirmation) {
    return {
      opened: false,
      reason: `checklist score ${decision.score} below the ${cfg.min_confirmation} threshold`,
    };
  }
  const setup = decision.setup;

  // Resolve the actual contract so the fill comes from its own quote, not
  // the chain snapshot — the chain may be a few seconds old.
  // Prefer the spelling of the contract that the brokers actually configured
  // can price; the fill below is simulated from that row's own quote.
  const contract = await instrumentsRepo.findOptionContract(
    underlying, expiry, setup.strike!, setup.optionType!,
    registry.candidates('quote').map((p) => p.manifest.id),
  );
  if (!contract) return { opened: false, reason: 'contract not found in the master' };

  // One position per contract: the engine re-proposes the same setup every
  // cycle while it remains valid, and without this it would stack.
  const dupe = await queryOne<{ id: string }>(
    `SELECT id FROM paper_trades
      WHERE user_id = $1 AND status = 'OPEN' AND instrument_id = $2 LIMIT 1`,
    [cfg.user_id, contract.id],
  );
  if (dupe) return { opened: false, reason: 'already holding this contract' };

  // Re-entering a minute after the direction guard closed the last position is
  // how a day turns into twenty small losses. After a forced exit the
  // underlying is left alone for a while, and a contract that lost money today
  // is not bought again today.
  const recentExit = await queryOne<{ exit_reason: string; minutes: string }>(
    `SELECT exit_reason, EXTRACT(EPOCH FROM (now() - exit_at))::int / 60 AS minutes
       FROM paper_trades
      WHERE user_id = $1 AND underlying = $2 AND status = 'CLOSED'
        AND exit_reason IN ('THESIS','STOP','GIVEBACK','NEWS')
        AND exit_at > now() - ($3 || ' minutes')::interval
      ORDER BY exit_at DESC LIMIT 1`,
    [cfg.user_id, underlying, String(cfg.reentry_cooldown_min)],
  );
  if (recentExit && cfg.reentry_cooldown_min > 0) {
    return {
      opened: false,
      reason: `cooling off — ${underlying} was closed ${recentExit.minutes} min ago (${recentExit.exit_reason.toLowerCase()}); no re-entry for ${cfg.reentry_cooldown_min} minutes`,
    };
  }
  const lostToday = await queryOne<{ id: string }>(
    `SELECT id FROM paper_trades
      WHERE user_id = $1 AND instrument_id = $2 AND status = 'CLOSED' AND net_pnl < 0
        AND (exit_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
      LIMIT 1`,
    [cfg.user_id, contract.id],
  );
  if (lostToday) return { opened: false, reason: `${contract.tradingsymbol} already lost money today; not buying it again today` };

  const fill = await simulateFill(registry, contract, 'BUY');
  if (!fill) return { opened: false, reason: 'no quote for the contract, cannot simulate a fill' };

  await query(
    `INSERT INTO paper_trades
       (user_id, instrument_id, tradingsymbol, exchange, underlying, kind, side,
        quantity, lot_size, entry_price, entry_reference, stop_price, target_price,
        underlying_stop, confirmation, rationale, evidence)
     VALUES ($1,$2,$3,$4,$5,'OPTION','BUY',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [
      cfg.user_id, contract.id, contract.tradingsymbol, contract.exchange, underlying,
      setup.sizing!.quantity, setup.lotSize, fill.price, fill.reference,
      setup.stopPremium, setup.targetPremium, setup.underlyingStop,
      decision.score, decision.summary,
      JSON.stringify({
        grade: decision.grade, score: decision.score, factors: decision.factors,
        plan: decision.plan, evidence: setup.evidence, signalId: evaluation.signalId,
      }),
    ],
  );

  log.info(
    { userId: cfg.user_id, symbol: contract.tradingsymbol, qty: setup.sizing!.quantity, price: fill.price },
    'Paper position opened',
  );
  const lots = setup.lotSize ? Math.round(setup.sizing!.quantity / setup.lotSize) : setup.sizing!.quantity;
  await notify(cfg.user_id, {
    kind: 'paper', severity: 'action',
    title: `Paper trade: bought ${lots} lot(s) ${contract.tradingsymbol}`,
    message: `Filled at ₹${fill.price.toFixed(2)} × ${setup.sizing!.quantity} (grade ${decision.grade}, score ${decision.score}). ` +
      `Stop ₹${(setup.stopPremium ?? 0).toFixed(2)}, target ₹${(setup.targetPremium ?? 0).toFixed(2)}` +
      (setup.underlyingStop !== null ? `, out if ${underlying} crosses ${setup.underlyingStop.toFixed(0)}` : '') +
      (cfg.intraday_only ? '. Intraday: flat by the square-off.' : '.'),
    payload: { symbol: contract.tradingsymbol, quantity: setup.sizing!.quantity, price: fill.price, grade: decision.grade },
    link: '/paper',
  });
  return { opened: true, reason: 'opened' };
}

/**
 * Open the setup the user is currently looking at.
 *
 * Separate from the sweep because the intent is different: the sweep decides
 * for itself, this acts on a decision the user has already seen and agreed
 * with. It still enforces every limit — one-click must not become a way to
 * bypass the daily loss cap or the position count.
 */
export async function openFromSetup(
  userId: string,
  underlying: string,
): Promise<{ opened: boolean; reason: string }> {
  const cfg = await getConfig(userId);
  if (!cfg) {
    return { opened: false, reason: 'Set your capital on the Paper Trading page first.' };
  }

  // Deliberately not checking is_enabled: clicking the button is the
  // instruction. The risk limits below still apply in full.
  if (cfg.halted_reason) {
    return { opened: false, reason: `Trading is halted: ${cfg.halted_reason}` };
  }

  const state = await limitState(userId);
  const capital = Number(cfg.capital);
  const lossLimit = capital * (Number(cfg.max_daily_loss_pct) / 100);

  if (state.netPnlToday <= -lossLimit) {
    const reason =
      `Daily loss limit reached — ₹${Math.abs(state.netPnlToday).toFixed(0)} against a ` +
      `₹${lossLimit.toFixed(0)} cap. No new positions today.`;
    await halt(userId, reason);
    return { opened: false, reason };
  }
  if (state.openCount >= cfg.max_open_positions) {
    return {
      opened: false,
      reason: `${state.openCount} positions already open (your limit is ${cfg.max_open_positions}).`,
    };
  }
  if (state.tradesToday >= cfg.max_trades_per_day) {
    return {
      opened: false,
      reason: `${state.tradesToday} trades already today (your limit is ${cfg.max_trades_per_day}).`,
    };
  }

  const registry = await registryForUser(userId);
  return tryOpenOptionTrade(registry, cfg, underlying.toUpperCase());
}

// ── exits ───────────────────────────────────────────────────────────────────

export interface ExitResult {
  checked: number;
  closed: number;
}

/**
 * Close simulated positions whose stop or target has been reached.
 *
 * When both are inside the same observation the stop wins. A single quote
 * cannot say which came first, and assuming the favourable one is how a
 * simulation invents an edge it does not have.
 */
export async function runExitSweep(userId: string): Promise<ExitResult> {
  const open = await queryRows<PaperTradeRow>(
    `SELECT * FROM paper_trades WHERE user_id = $1 AND status = 'OPEN'`,
    [userId],
  );
  if (open.length === 0) return { checked: 0, closed: 0 };

  const registry = await registryForUser(userId);
  const cfg = await getConfig(userId);
  const intraday = cfg ? intradayCfg(cfg) : { intradayOnly: true, entryCutoffMin: 870, squareOffMin: 915 };
  const guardOn = cfg?.direction_guard ?? true;
  const guardCfg = { ...DEFAULT_GUARD, cutLoserAtR: Number(cfg?.cut_loser_at_r ?? 0.5) };
  const horizon: 'intraday' | 'swing' = cfg?.intraday_only === false ? 'swing' : 'intraday';
  const spots = new Map<string, number | null>();
  const now = new Date();
  let closed = 0;

  for (const trade of open) {
    if (trade.instrument_id === null) continue;
    const instrument = await instrumentsRepo.getById(trade.instrument_id);
    if (!instrument) continue;

    const quote = await getQuote(registry, instrument);
    if (!isAvailable(quote)) continue;

    const ltp = quote.value.ltp;
    const stop = n(trade.stop_price);
    const target = n(trade.target_price);
    const entry = Number(trade.entry_price);
    const best = Math.max(n(trade.max_favourable_premium) ?? ltp, ltp);
    await query(`UPDATE paper_trades SET max_favourable_premium = $2, updated_at = now() WHERE id = $1`, [trade.id, best]);

    // Spot of the underlying, once per underlying per sweep, for the underlying-level stop.
    let spot: number | null = null;
    if (trade.underlying) {
      if (!spots.has(trade.underlying)) {
        const row = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(trade.underlying));
        const sq = row ? await getQuote(registry, row) : null;
        spots.set(trade.underlying, sq && isAvailable(sq) ? sq.value.ltp : null);
      }
      spot = spots.get(trade.underlying) ?? null;
    }
    const uStop = n(trade.underlying_stop);
    const bull = trade.tradingsymbol.endsWith('CE');

    // Order of precedence: square-off, the plan's stops and target, then the chart.
    const eod = squareOffDue(intraday, new Date(trade.entry_at), now);
    let reason: PaperExitReason | null = null;
    let why = '';
    if (eod.due) { reason = 'EOD'; why = eod.reason; }
    else if (stop !== null && ltp <= stop) { reason = 'STOP'; why = `premium ₹${ltp.toFixed(2)} at or below the ₹${stop.toFixed(2)} stop`; }
    else if (uStop !== null && spot !== null && (bull ? spot <= uStop : spot >= uStop)) {
      reason = 'STOP'; why = `${trade.underlying} traded through ${uStop.toFixed(0)} (spot ${spot.toFixed(2)}); the thesis is invalid`;
    }
    else if (target !== null && ltp >= target) { reason = 'TARGET'; why = `premium ₹${ltp.toFixed(2)} reached the ₹${target.toFixed(2)} target`; }
    else if (guardOn && trade.underlying) {
      const read = await readDirection(registry, trade.underlying, horizon);
      const g = decideDirectionExit({
        action: bull ? 'BUY_CALL' : 'BUY_PUT', horizon, entryPremium: entry, premium: ltp,
        stopPremium: stop ?? 0.05, target1Premium: target ?? entry * 1.2,
        maxFavourablePremium: best,
      }, read, guardCfg);
      if (g.kind === 'EXIT') { reason = g.code === 'GIVEBACK' ? 'GIVEBACK' : 'THESIS'; why = g.reason; }
      else if (g.kind === 'RAISE_STOP') {
        await tightenPaperStop(trade.id, g.newStop);
        log.info({ tradeId: trade.id, newStop: g.newStop }, 'Paper stop raised to breakeven');
        await notify(trade.user_id, { kind: 'paper', severity: 'info', title: `${trade.tradingsymbol}: stop moved to breakeven`, message: g.reason, link: '/paper' });
        continue;
      } else continue;
    }
    if (reason === null) continue;
    log.info({ tradeId: trade.id, symbol: trade.tradingsymbol, reason, why }, 'Paper exit');

    const fill = await simulateFill(registry, instrument, 'SELL');
    if (!fill) continue;

    await closeTrade(trade, fill, reason);
    closed += 1;
  }

  return { checked: open.length, closed };
}

export type PaperExitReason = 'STOP' | 'TARGET' | 'EOD' | 'MANUAL' | 'EXPIRY' | 'NEWS' | 'THESIS' | 'GIVEBACK';

async function closeTrade(
  trade: PaperTradeRow,
  fill: Fill,
  reason: PaperExitReason,
): Promise<void> {
  const entry = Number(trade.entry_price);
  const qty = trade.quantity;
  const gross = (fill.price - entry) * qty;

  // Options are charged as FNO; the cost stack differs materially from cash.
  const segment: Segment = trade.kind === 'OPTION' ? 'OPT' : 'EQ_INTRADAY';
  const costs = calculateRoundTripCosts(entry, fill.price, qty, segment, 'LONG');

  const net = gross - costs.total;

  await query(
    `UPDATE paper_trades SET
       status = 'CLOSED', exit_price = $2, exit_reference = $3, exit_at = now(),
       exit_reason = $4, gross_pnl = $5, costs = $6, net_pnl = $7, updated_at = now()
     WHERE id = $1`,
    [trade.id, fill.price, fill.reference, reason, gross, costs.total, net],
  );

  log.info(
    { symbol: trade.tradingsymbol, reason, gross: gross.toFixed(2), net: net.toFixed(2) },
    'Paper position closed',
  );
  const why: Record<PaperExitReason, string> = {
    STOP: 'stop hit', TARGET: 'target reached', EOD: 'intraday square-off', MANUAL: 'closed by you',
    EXPIRY: 'contract expired', NEWS: 'news turned the chart against it',
    THESIS: 'direction changed on the chart', GIVEBACK: 'profit protected before it turned into a loss',
  };
  await notify(trade.user_id, {
    kind: 'paper', severity: reason === 'STOP' ? 'warning' : 'action',
    title: `Paper trade closed: ${trade.tradingsymbol} ${net >= 0 ? '+' : ''}₹${net.toFixed(0)}`,
    message: `Sold ${qty} at ₹${fill.price.toFixed(2)} (${why[reason]}). Bought at ₹${entry.toFixed(2)}; ` +
      `₹${gross.toFixed(0)} before charges, ₹${net.toFixed(0)} after.`,
    payload: { tradeId: trade.id, reason, exitPrice: fill.price, net },
    link: '/paper',
  });
}

/** Close an open position at the current price, on the user's instruction. */
export async function closeManually(userId: string, tradeId: string): Promise<boolean> {
  return closePaperTrade(userId, tradeId, 'MANUAL');
}

/** Close an open paper position at the current price for a stated reason. */
export async function closePaperTrade(
  userId: string,
  tradeId: string,
  reason: PaperExitReason,
): Promise<boolean> {
  const trade = await queryOne<PaperTradeRow>(
    `SELECT * FROM paper_trades WHERE id = $1 AND user_id = $2 AND status = 'OPEN'`,
    [tradeId, userId],
  );
  if (!trade || trade.instrument_id === null) return false;

  const instrument = await instrumentsRepo.getById(trade.instrument_id);
  if (!instrument) return false;

  const registry = await registryForUser(userId);
  const fill = await simulateFill(registry, instrument, 'SELL');
  if (!fill) return false;

  await closeTrade(trade, fill, reason);
  return true;
}

/** Move the stop on an open paper position — only ever upward. */
export async function tightenPaperStop(tradeId: string, newStop: number): Promise<void> {
  await query(
    `UPDATE paper_trades SET stop_price = GREATEST(COALESCE(stop_price, 0), $2), updated_at = now()
      WHERE id = $1 AND status = 'OPEN'`,
    [tradeId, newStop],
  );
}

// ── reporting ───────────────────────────────────────────────────────────────

export interface PaperPerformance {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  /** Share of closed trades that were profitable after costs. */
  winRate: number | null;
  grossPnl: number;
  totalCosts: number;
  netPnl: number;
  /** Net P&L as a percent of stated capital. */
  returnPct: number | null;
  bestTrade: number | null;
  worstTrade: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross profit divided by gross loss. Null until there is a loss. */
  profitFactor: number | null;
  /** Plain statement of what this does and does not establish. */
  caveat: string;
}

export async function getPerformance(userId: string): Promise<PaperPerformance> {
  const cfg = await getConfig(userId);
  const row = await queryOne<Record<string, string | null>>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'OPEN')::text AS open,
       COUNT(*) FILTER (WHERE status = 'CLOSED')::text AS closed,
       COUNT(*) FILTER (WHERE status = 'CLOSED' AND net_pnl > 0)::text AS wins,
       COUNT(*) FILTER (WHERE status = 'CLOSED' AND net_pnl <= 0)::text AS losses,
       COALESCE(SUM(gross_pnl), 0)::text AS gross,
       COALESCE(SUM(costs), 0)::text AS costs,
       COALESCE(SUM(net_pnl), 0)::text AS net,
       MAX(net_pnl)::text AS best,
       MIN(net_pnl)::text AS worst,
       AVG(net_pnl) FILTER (WHERE net_pnl > 0)::text AS avg_win,
       AVG(net_pnl) FILTER (WHERE net_pnl <= 0)::text AS avg_loss,
       COALESCE(SUM(net_pnl) FILTER (WHERE net_pnl > 0), 0)::text AS gross_profit,
       COALESCE(ABS(SUM(net_pnl) FILTER (WHERE net_pnl <= 0)), 0)::text AS gross_loss
     FROM paper_trades WHERE user_id = $1`,
    [userId],
  );

  const closed = Number(row?.['closed'] ?? 0);
  const wins = Number(row?.['wins'] ?? 0);
  const grossProfit = Number(row?.['gross_profit'] ?? 0);
  const grossLoss = Number(row?.['gross_loss'] ?? 0);
  const net = Number(row?.['net'] ?? 0);
  const capital = cfg ? Number(cfg.capital) : null;

  return {
    totalTrades: Number(row?.['total'] ?? 0),
    openTrades: Number(row?.['open'] ?? 0),
    closedTrades: closed,
    wins,
    losses: Number(row?.['losses'] ?? 0),
    winRate: closed > 0 ? (wins / closed) * 100 : null,
    grossPnl: Number(row?.['gross'] ?? 0),
    totalCosts: Number(row?.['costs'] ?? 0),
    netPnl: net,
    returnPct: capital && capital > 0 ? (net / capital) * 100 : null,
    bestTrade: n(row?.['best'] ?? null),
    worstTrade: n(row?.['worst'] ?? null),
    avgWin: n(row?.['avg_win'] ?? null),
    avgLoss: n(row?.['avg_loss'] ?? null),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    caveat:
      closed < 30
        ? `Only ${closed} closed trade(s). A handful of results says almost nothing about a ` +
          'strategy — the spread of outcomes at this sample size is wider than any edge you ' +
          'are trying to measure.'
        : 'Simulated fills assume your order would have been filled at the quoted price plus ' +
          'slippage. Real fills on illiquid strikes can be materially worse, and a live account ' +
          'also faces gaps through the stop.',
  };
}

export async function listTrades(
  userId: string,
  opts: { status?: 'OPEN' | 'CLOSED'; limit?: number } = {},
): Promise<PaperTradeRow[]> {
  return queryRows<PaperTradeRow>(
    `SELECT * FROM paper_trades
      WHERE user_id = $1 AND ($2::text IS NULL OR status = $2)
      ORDER BY entry_at DESC LIMIT $3`,
    [userId, opts.status ?? null, Math.min(opts.limit ?? 100, 500)],
  );
}
