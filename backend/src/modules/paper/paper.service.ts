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
import { getCandles } from '../market/marketData.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { buildOptionSetup } from '../../analysis/options/setupEngine.js';
import { calculateRoundTripCosts, type Segment } from '../../analysis/backtest/costs.js';
import { getExpiries, getOptionChain, underlyingInstrumentFor } from '../options/options.service.js';

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
  halted_reason: string | null;
  halted_at: Date | null;
}

export interface PaperTradeRow {
  id: string;
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
  const q = quote.value;

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
  }>,
): Promise<PaperConfig> {
  const existing = await getConfig(userId);

  if (!existing) {
    if (!patch.capital || patch.capital <= 0) {
      throw new Error('Capital is required to start paper trading.');
    }
    await query(
      `INSERT INTO paper_trade_config
         (user_id, is_enabled, capital, risk_per_trade_pct, max_open_positions,
          max_trades_per_day, max_daily_loss_pct, min_confirmation, underlyings,
          trade_options, trade_equity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        userId, patch.isEnabled ?? false, patch.capital, patch.riskPerTradePct ?? 1,
        patch.maxOpenPositions ?? 3, patch.maxTradesPerDay ?? 5, patch.maxDailyLossPct ?? 3,
        patch.minConfirmation ?? 60, patch.underlyings ?? ['NIFTY'],
        patch.tradeOptions ?? true, patch.tradeEquity ?? true,
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
       updated_at = now()
     WHERE user_id = $1`,
    [
      userId, patch.isEnabled ?? null, patch.capital ?? null, patch.riskPerTradePct ?? null,
      patch.maxOpenPositions ?? null, patch.maxTradesPerDay ?? null, patch.maxDailyLossPct ?? null,
      patch.minConfirmation ?? null, patch.underlyings ?? null,
      patch.tradeOptions ?? null, patch.tradeEquity ?? null, clearHalt,
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
  return null;
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

  return { considered, opened, skipped };
}

async function tryOpenOptionTrade(
  registry: ProviderRegistry,
  cfg: PaperConfig,
  underlying: string,
): Promise<{ opened: boolean; reason: string }> {
  const expiries = await getExpiries(registry, underlying);
  if (!isAvailable(expiries) || expiries.value.length === 0) {
    return { opened: false, reason: 'no expiries listed' };
  }
  const expiry = expiries.value[0]!;

  const chain = await getOptionChain(registry, underlying, expiry);
  if (!isAvailable(chain)) return { opened: false, reason: chain.detail ?? 'chain unavailable' };

  const spotInstrument = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(underlying));
  if (!spotInstrument) return { opened: false, reason: 'underlying not in the instrument master' };

  const candles = await getCandles(registry, spotInstrument, '1d', { bars: 300 });
  if (candles.candles.length < 30) {
    return { opened: false, reason: `only ${candles.candles.length} bars of history` };
  }
  const snapshot = buildSnapshot(spotInstrument.tradingsymbol, '1d', candles.candles);

  const setup = buildOptionSetup({
    underlying,
    chain: chain.value,
    signal: runSignalEngine(snapshot),
    atr: snapshot.volatility.atr14,
    capital: Number(cfg.capital),
    riskPercent: Number(cfg.risk_per_trade_pct),
  });

  if (setup.action === 'NO_TRADE') {
    return { opened: false, reason: setup.rejectedBecause[0] ?? 'no setup' };
  }
  if (setup.confirmation < cfg.min_confirmation) {
    return {
      opened: false,
      reason: `confirmation ${setup.confirmation} below the ${cfg.min_confirmation} threshold`,
    };
  }

  // Resolve the actual contract so the fill comes from its own quote, not
  // the chain snapshot — the chain may be a few seconds old.
  const contract = await instrumentsRepo.findOptionContract(
    underlying, expiry, setup.strike!, setup.optionType!,
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
      setup.confirmation, setup.interpretation, JSON.stringify(setup.evidence),
    ],
  );

  log.info(
    { userId: cfg.user_id, symbol: contract.tradingsymbol, qty: setup.sizing!.quantity, price: fill.price },
    'Paper position opened',
  );
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

    let reason: 'STOP' | 'TARGET' | null = null;
    if (stop !== null && ltp <= stop) reason = 'STOP';
    else if (target !== null && ltp >= target) reason = 'TARGET';
    if (reason === null) continue;

    const fill = await simulateFill(registry, instrument, 'SELL');
    if (!fill) continue;

    await closeTrade(trade, fill, reason);
    closed += 1;
  }

  return { checked: open.length, closed };
}

async function closeTrade(
  trade: PaperTradeRow,
  fill: Fill,
  reason: 'STOP' | 'TARGET' | 'EOD' | 'MANUAL' | 'EXPIRY',
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
}

/** Close an open position at the current price, on the user's instruction. */
export async function closeManually(userId: string, tradeId: string): Promise<boolean> {
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

  await closeTrade(trade, fill, 'MANUAL');
  return true;
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
