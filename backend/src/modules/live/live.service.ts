/**
 * Live trading — real option orders, routed to the user's broker from the
 * decision engine's plan.
 *
 * The shape of this module is the shape of a disciplined desk:
 *
 *   · nothing is sent unless the user armed the day, stated the capital, and
 *     every guard in `liveBlockers` is clear — the guards are re-run at the
 *     moment of each order, not just when the page loaded;
 *   · entries are limit orders inside the quoted spread, cancelled if unfilled
 *     within the configured timeout — a market order into a thin strike is how
 *     a plan's reward:risk disappears before the trade has begun;
 *   · exits are the plan applied mechanically by a worker every few seconds:
 *     stop, invalidation, square-off, targets, in that order;
 *   · a daily loss cap halts the day; a kill switch cancels and flattens;
 *   · every request to the broker and every reply is kept on the trade row.
 *
 * What this module does not do is predict. It executes a plan the engine
 * graded and the journal measures. The track record is the only claim.
 */
import { query, queryRows, queryOne } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registryForUser, type ProviderRegistry } from '../../providers/registry.js';
import type { MarketDataProvider, NormalizedOrder, NormalizedFunds } from '../../providers/types.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getQuote, marketStatus } from '../market/marketData.service.js';
import { underlyingInstrumentFor } from '../options/options.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { evaluateUnderlying } from '../fno/fno.service.js';
import { meetsGrade, calendarDaysToExpiry, type Grade } from '../../analysis/options/decisionEngine.js';
import {
  liveBlockers, decideLiveExit,
  type LiveMode, type LiveBlocker, type LiveGuardConfig,
} from '../../analysis/options/liveGuards.js';
import { calculateRoundTripCosts } from '../../analysis/backtest/costs.js';
import { notify } from '../notifications/notifications.service.js';
import { toIst, fromIst } from '../../utils/time.js';

const log = logger.child({ module: 'live' });

// ── config ──────────────────────────────────────────────────────────────────

export interface LiveConfigRow {
  user_id: string;
  mode: LiveMode;
  armed_until: Date | null;
  capital: string | null;
  risk_per_trade_pct: string;
  max_open_positions: number;
  max_lots_per_trade: number;
  max_trades_per_day: number;
  max_daily_loss_pct: string;
  underlyings: string[];
  min_grade: Grade;
  allow_expiry_day: boolean;
  window_start_min: number;
  window_end_min: number;
  square_off_min: number;
  product: 'INTRADAY' | 'CARRYFORWARD';
  scale_out: boolean;
  entry_timeout_sec: number;
  kill_switch: boolean;
  halted_reason: string | null;
  halted_at: Date | null;
  last_sweep_at: Date | null;
  last_sweep_result: unknown;
}

export interface LiveConfigPatch {
  mode?: LiveMode;
  riskPerTradePct?: number;
  maxOpenPositions?: number;
  maxLotsPerTrade?: number;
  maxTradesPerDay?: number;
  maxDailyLossPct?: number;
  underlyings?: string[];
  minGrade?: Grade;
  allowExpiryDay?: boolean;
  windowStartMin?: number;
  windowEndMin?: number;
  squareOffMin?: number;
  product?: 'INTRADAY' | 'CARRYFORWARD';
  scaleOut?: boolean;
  entryTimeoutSec?: number;
}

export async function getLiveConfig(userId: string): Promise<LiveConfigRow | null> {
  return queryOne<LiveConfigRow>(`SELECT * FROM live_trade_config WHERE user_id = $1`, [userId]);
}

async function ensureConfig(userId: string): Promise<LiveConfigRow> {
  await query(`INSERT INTO live_trade_config (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  return (await getLiveConfig(userId))!;
}

export async function upsertLiveConfig(userId: string, p: LiveConfigPatch): Promise<LiveConfigRow> {
  await ensureConfig(userId);
  if (p.windowStartMin !== undefined && p.windowEndMin !== undefined && p.windowStartMin >= p.windowEndMin) {
    throw new Error('The entry window must start before it ends.');
  }
  await query(
    `UPDATE live_trade_config SET
       mode = COALESCE($2, mode),
       risk_per_trade_pct = COALESCE($3, risk_per_trade_pct),
       max_open_positions = COALESCE($4, max_open_positions),
       max_lots_per_trade = COALESCE($5, max_lots_per_trade),
       max_trades_per_day = COALESCE($6, max_trades_per_day),
       max_daily_loss_pct = COALESCE($7, max_daily_loss_pct),
       underlyings = COALESCE($8, underlyings),
       min_grade = COALESCE($9, min_grade),
       allow_expiry_day = COALESCE($10, allow_expiry_day),
       window_start_min = COALESCE($11, window_start_min),
       window_end_min = COALESCE($12, window_end_min),
       square_off_min = COALESCE($13, square_off_min),
       product = COALESCE($14, product),
       scale_out = COALESCE($15, scale_out),
       entry_timeout_sec = COALESCE($16, entry_timeout_sec),
       updated_at = now()
     WHERE user_id = $1`,
    [
      userId, p.mode ?? null, p.riskPerTradePct ?? null, p.maxOpenPositions ?? null,
      p.maxLotsPerTrade ?? null, p.maxTradesPerDay ?? null, p.maxDailyLossPct ?? null,
      p.underlyings?.map((u) => u.toUpperCase()) ?? null, p.minGrade ?? null, p.allowExpiryDay ?? null,
      p.windowStartMin ?? null, p.windowEndMin ?? null, p.squareOffMin ?? null, p.product ?? null,
      p.scaleOut ?? null, p.entryTimeoutSec ?? null,
    ],
  );
  return (await getLiveConfig(userId))!;
}

// ── funds ───────────────────────────────────────────────────────────────────

export interface LiveFunds extends NormalizedFunds {
  broker: string;
}

/**
 * The real account balance, straight from the broker. The platform never
 * types this in or remembers it: every call asks the broker again, and a
 * failure is reported as a failure rather than a stale number.
 */
export async function brokerFunds(userId: string): Promise<LiveFunds> {
  const registry = await registryForUser(userId);
  const broker = registry.candidates('funds')[0];
  if (!broker?.getFunds) throw new Error('No configured broker reports account funds. Connect Angel One in Settings.');
  const funds = await broker.getFunds();
  return { ...funds, broker: broker.manifest.id };
}

/**
 * Pull the balance again and store it as the capital base, so sizing and
 * the daily loss cap follow the real account. On a broker failure the last
 * stored figure stands; the caller decides whether that is acceptable.
 */
async function refreshCapital(userId: string): Promise<{ capital: number; fresh: boolean }> {
  const cfg = await ensureConfig(userId);
  try {
    const funds = await brokerFunds(userId);
    await query(`UPDATE live_trade_config SET capital = $2, updated_at = now() WHERE user_id = $1`, [userId, funds.availableCash]);
    return { capital: funds.availableCash, fresh: true };
  } catch (err) {
    log.warn({ userId, err: (err as Error).message }, 'Could not refresh capital from the broker; using the stored figure');
    return { capital: cfg.capital === null ? 0 : Number(cfg.capital), fresh: false };
  }
}

/**
 * Arm for today's session. Expires at 15:30 IST so live trading is a
 * decision made each morning. The capital base is the broker's available
 * cash at this moment, fetched here, never typed in.
 */
export async function arm(userId: string): Promise<LiveConfigRow> {
  const cfg = await ensureConfig(userId);
  if (cfg.mode === 'OFF') throw new Error('Choose Confirm or Auto mode before arming.');
  const funds = await brokerFunds(userId);
  const capital = funds.availableCash;
  if (!(capital > 0)) throw new Error(`Your ${funds.broker} account shows no available cash (₹${capital.toLocaleString('en-IN')}). Add funds at the broker, then arm.`);
  const ist = toIst();
  if (ist.minutesOfDay >= 15 * 60 + 30) throw new Error('The session is over for today. Arm again tomorrow morning.');
  if (ist.weekday === 0 || ist.weekday === 6) throw new Error('The market is closed today.');
  const until = fromIst(ist.dateKey, 15, 30);
  await query(
    `UPDATE live_trade_config SET armed_until = $2, capital = $3, kill_switch = FALSE,
            halted_reason = NULL, halted_at = NULL, updated_at = now()
      WHERE user_id = $1`,
    [userId, until, capital],
  );
  log.warn({ userId, capital, until: until.toISOString() }, 'LIVE TRADING ARMED');
  await notify(userId, {
    kind: 'live', severity: 'warning', title: 'Live trading armed',
    message: `Armed until 15:30 IST in ${cfg.mode} mode. Your ${funds.broker} account shows ₹${capital.toLocaleString('en-IN')} available, and that is the capital base. Real orders can now be placed within your caps.`,
    link: '/live',
  });
  return (await getLiveConfig(userId))!;
}

export async function disarm(userId: string): Promise<void> {
  await query(`UPDATE live_trade_config SET armed_until = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
  log.warn({ userId }, 'Live trading disarmed');
}

async function halt(userId: string, reason: string): Promise<void> {
  await query(
    `UPDATE live_trade_config SET halted_reason = $2, halted_at = now(), updated_at = now()
      WHERE user_id = $1 AND halted_reason IS NULL`,
    [userId, reason],
  );
  log.warn({ userId, reason }, 'LIVE TRADING HALTED');
  await notify(userId, { kind: 'live', severity: 'warning', title: 'Live trading halted', message: reason, link: '/live' });
}

// ── state and guards ────────────────────────────────────────────────────────

interface LiveState {
  openPositions: number;
  tradesToday: number;
  netPnlToday: number;
}

async function liveState(userId: string): Promise<LiveState> {
  const row = await queryOne<{ open: string; today: string; pnl: string }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('PENDING','OPEN','EXITING'))::text AS open,
            COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE AND status <> 'FAILED')::text AS today,
            COALESCE(SUM(net_pnl) FILTER (WHERE closed_at::date = CURRENT_DATE), 0)::text AS pnl
       FROM live_trades WHERE user_id = $1`,
    [userId],
  );
  return {
    openPositions: Number(row?.open ?? 0),
    tradesToday: Number(row?.today ?? 0),
    netPnlToday: Number(row?.pnl ?? 0),
  };
}

const guardConfig = (c: LiveConfigRow): LiveGuardConfig => ({
  mode: c.mode,
  armedUntil: c.armed_until,
  capital: c.capital === null ? null : Number(c.capital),
  killSwitch: c.kill_switch,
  haltedReason: c.halted_reason,
  allowExpiryDay: c.allow_expiry_day,
  windowStartMin: c.window_start_min,
  windowEndMin: c.window_end_min,
  maxOpenPositions: c.max_open_positions,
  maxTradesPerDay: c.max_trades_per_day,
  maxDailyLossPct: Number(c.max_daily_loss_pct),
  minGrade: c.min_grade,
});

async function blockersFor(userId: string, cfg: LiveConfigRow, daysToExpiry: number | null): Promise<LiveBlocker[]> {
  const [state, market] = await Promise.all([liveState(userId), marketStatus()]);
  return liveBlockers(guardConfig(cfg), {
    ...state, marketPhase: market.phase, now: new Date(), daysToExpiry,
  });
}

export interface LiveStatus {
  config: LiveConfigRow | null;
  armed: boolean;
  blockers: LiveBlocker[];
  openPositions: number;
  tradesToday: number;
  netPnlToday: number;
  marketPhase: string;
  brokerReady: boolean;
  broker: string | null;
  headline: string;
}

export async function getLiveStatus(userId: string): Promise<LiveStatus> {
  const cfg = await getLiveConfig(userId);
  const [state, market, registry] = await Promise.all([liveState(userId), marketStatus(), registryForUser(userId)]);
  const broker = registry.candidates('orders')[0] ?? null;
  const base = {
    openPositions: state.openPositions, tradesToday: state.tradesToday, netPnlToday: state.netPnlToday,
    marketPhase: market.phase, brokerReady: broker !== null, broker: broker?.manifest.id ?? null,
  };
  if (!cfg) {
    return {
      ...base, config: null, armed: false,
      blockers: [{ code: 'not_set_up', detail: 'Live trading has never been configured.', fix: 'Set your caps, choose a mode, then arm.' }],
      headline: 'Not set up. Live trading is off.',
    };
  }
  const blockers = liveBlockers(guardConfig(cfg), { ...state, marketPhase: market.phase, now: new Date(), daysToExpiry: null });
  if (!broker) {
    blockers.unshift({ code: 'no_broker', detail: 'No configured broker can place orders. Angel One is the only adapter with order routing.', fix: 'Settings → Market data providers.' });
  }
  const armed = cfg.armed_until !== null && cfg.armed_until.getTime() > Date.now();
  const headline =
    cfg.kill_switch ? 'Kill switch engaged — nothing will be placed until you reset it.'
    : cfg.halted_reason ? `Halted: ${cfg.halted_reason}`
    : cfg.mode === 'OFF' ? 'Off. No orders are ever placed in this mode.'
    : !armed ? `${cfg.mode} mode, not armed. Nothing is placed until you arm for the session.`
    : blockers.length > 0 ? `Armed in ${cfg.mode} mode, but blocked — ${blockers[0]!.detail}`
    : cfg.mode === 'AUTO'
      ? `Armed in AUTO mode: the worker will place orders on ${cfg.underlyings.join(', ')} when the engine grades ${cfg.min_grade} or better.`
      : `Armed in CONFIRM mode: press "Execute live" on an Enter-grade decision to place the order.`;
  return { ...base, config: cfg, armed, blockers, headline };
}

// ── broker plumbing ─────────────────────────────────────────────────────────

function brokerFor(registry: ProviderRegistry): MarketDataProvider {
  const broker = registry.candidates('orders')[0];
  if (!broker) throw new Error('No configured broker can place orders.');
  return broker;
}

async function logBroker(tradeId: number, entry: Record<string, unknown>): Promise<void> {
  await query(
    `UPDATE live_trades SET broker_log = broker_log || $2::jsonb, updated_at = now() WHERE id = $1`,
    [tradeId, JSON.stringify([{ at: new Date().toISOString(), ...entry }])],
  );
}

const roundTick = (p: number): number => Math.round(p * 20) / 20;

// ── trades ──────────────────────────────────────────────────────────────────

export interface LiveTradeRow {
  id: string;
  user_id: string;
  signal_id: string | null;
  mode: 'CONFIRM' | 'AUTO';
  broker: string;
  instrument_id: string | null;
  tradingsymbol: string;
  exchange: string;
  underlying: string;
  expiry: string;
  strike: string;
  option_type: 'CE' | 'PE';
  action: 'BUY_CALL' | 'BUY_PUT';
  product: 'INTRADAY' | 'CARRYFORWARD';
  lot_size: number;
  lots: number;
  quantity: number;
  entry_order_id: string | null;
  entry_order_status: string;
  entry_limit: string | null;
  entry_price: string | null;
  entry_filled_qty: number;
  entry_placed_at: Date;
  entry_at: Date | null;
  grade: string;
  score: number;
  stop_premium: string;
  target1_premium: string;
  target2_premium: string;
  underlying_stop: string;
  underlying_target1: string;
  underlying_target2: string;
  plan: unknown;
  scale_out: boolean;
  remaining_qty: number;
  t1_done: boolean;
  exit_order_id: string | null;
  exit_order_status: string | null;
  exit_order_qty: number | null;
  exit_kind: 'PARTIAL' | 'FULL' | null;
  exit_code: string | null;
  exit_placed_at: Date | null;
  exits: Array<{ qty: number; price: number; at: string; code: string; reason: string }>;
  last_premium: string | null;
  max_favourable_premium: string | null;
  max_adverse_premium: string | null;
  gross_pnl: string | null;
  costs: string | null;
  net_pnl: string | null;
  closed_at: Date | null;
  status: 'PENDING' | 'OPEN' | 'EXITING' | 'CLOSED' | 'FAILED';
  failure_reason: string | null;
  broker_log: unknown[];
  created_at: Date;
}

const TRADE_SELECT = `*, to_char(expiry, 'YYYY-MM-DD') AS expiry`;

export async function listLiveTrades(
  userId: string,
  opts: { status?: 'ACTIVE' | 'CLOSED'; limit?: number } = {},
): Promise<LiveTradeRow[]> {
  return queryRows<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades
      WHERE user_id = $1
        AND ($2::text IS NULL
             OR ($2 = 'ACTIVE' AND status IN ('PENDING','OPEN','EXITING'))
             OR ($2 = 'CLOSED' AND status IN ('CLOSED','FAILED')))
      ORDER BY created_at DESC LIMIT $3`,
    [userId, opts.status ?? null, Math.min(opts.limit ?? 100, 500)],
  );
}

export interface ExecuteResult {
  placed: boolean;
  reason: string;
  tradeId: number | null;
  orderId: string | null;
}

/**
 * Run the checklist and, if it says Enter, send the entry order.
 *
 * The guards run twice: before the (slow) evaluation and again immediately
 * before the order, because a position may have filled or the loss cap may
 * have tripped in between.
 */
export async function executeLive(
  userId: string,
  underlying: string,
  mode: 'CONFIRM' | 'AUTO',
): Promise<ExecuteResult> {
  const none = (reason: string): ExecuteResult => ({ placed: false, reason, tradeId: null, orderId: null });
  const cfg = await getLiveConfig(userId);
  if (!cfg) return none('Live trading is not set up.');
  if (mode === 'CONFIRM' && cfg.mode === 'OFF') return none('Live trading is switched off.');
  if (mode === 'AUTO' && cfg.mode !== 'AUTO') return none('Not in AUTO mode.');

  const early = await blockersFor(userId, cfg, null);
  if (early.length > 0) return none(early[0]!.detail);

  const registry = await registryForUser(userId);
  let broker: MarketDataProvider;
  try { broker = brokerFor(registry); } catch (err) { return none((err as Error).message); }

  // Size from the account as it is right now, not as it was this morning.
  const { capital } = await refreshCapital(userId);
  if (!(capital > 0)) return none('The broker reports no available cash to trade with.');
  const ev = await evaluateUnderlying(registry, underlying, {
    capital,
    riskPercent: Number(cfg.risk_per_trade_pct),
    record: { userId, origin: 'live' },
  });
  if (!isAvailable(ev.result) || !ev.expiry) {
    return none(isAvailable(ev.result) ? 'no expiry' : (ev.result.detail ?? ev.result.reason));
  }
  const d = ev.result.value;
  if (d.stance !== 'ENTER' || !d.plan) return none(`Grade ${d.grade}: ${d.holdBecause[0] ?? 'the checklist does not support an entry.'}`);
  if (!meetsGrade(d.grade, cfg.min_grade)) return none(`Grade ${d.grade} is below your minimum of ${cfg.min_grade}.`);
  if (!d.entryWindowOpen) return none(d.sessionNote);

  const late = await blockersFor(userId, cfg, calendarDaysToExpiry(d.expiry, new Date()));
  if (late.length > 0) return none(late[0]!.detail);

  const plan = d.plan;
  const lotSize = d.setup.lotSize ?? 1;
  const lots = Math.min(plan.lots, cfg.max_lots_per_trade);
  if (lots < 1) return none('The plan sizes to zero lots at this capital.');
  const quantity = lots * lotSize;

  const contract = await instrumentsRepo.findOptionContract(
    d.underlying, d.expiry, d.setup.strike!, d.setup.optionType!, [broker.manifest.id],
  );
  const token = contract ? instrumentsRepo.providerToken(contract, broker.manifest.id) : undefined;
  if (!contract || !token) return none(`${broker.manifest.displayName} has no symbol token for ${d.underlying} ${d.setup.strike} ${d.setup.optionType}.`);

  const dupe = await queryOne<{ id: string }>(
    `SELECT id FROM live_trades WHERE user_id = $1 AND instrument_id = $2 AND status IN ('PENDING','OPEN','EXITING') LIMIT 1`,
    [userId, contract.id],
  );
  if (dupe) return none(`Already in ${contract.tradingsymbol} (trade #${dupe.id}).`);

  const limit = roundTick(plan.entryZone.high);
  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO live_trades
       (user_id, signal_id, mode, broker, instrument_id, tradingsymbol, exchange, underlying, expiry,
        strike, option_type, action, product, lot_size, lots, quantity, entry_limit,
        grade, score, stop_premium, target1_premium, target2_premium,
        underlying_stop, underlying_target1, underlying_target2, plan, scale_out, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb,$27,'PENDING')
     RETURNING id`,
    [
      userId, ev.signalId, mode, broker.manifest.id, contract.id, contract.tradingsymbol, contract.exchange,
      d.underlying, d.expiry, d.setup.strike, d.setup.optionType, d.action, cfg.product, lotSize, lots, quantity,
      limit, d.grade, d.score, plan.stopPremium, plan.target1Premium, plan.target2Premium,
      plan.underlyingStop, plan.underlyingTarget1, plan.underlyingTarget2,
      JSON.stringify({ ...plan, factors: d.factors, summary: d.summary }), cfg.scale_out,
    ],
  );
  const tradeId = Number(inserted!.id);

  const req = {
    exchange: contract.exchange, tradingsymbol: contract.tradingsymbol, providerToken: token,
    side: 'BUY' as const, quantity, orderType: 'LIMIT' as const, price: limit,
    product: cfg.product, tag: `BT${tradeId}`,
  };
  try {
    const { orderId } = await broker.placeOrder!(req);
    await query(
      `UPDATE live_trades SET entry_order_id = $2, entry_order_status = 'OPEN', updated_at = now() WHERE id = $1`,
      [tradeId, orderId],
    );
    await logBroker(tradeId, { event: 'entry_placed', request: req, orderId });
    log.warn({ userId, tradeId, orderId, contract: contract.tradingsymbol, quantity, limit }, 'LIVE ENTRY ORDER PLACED');
    await notify(userId, {
      kind: 'live', severity: 'action',
      title: `Live order: buy ${lots} lot(s) ${contract.tradingsymbol}`,
      message: `Limit ₹${limit.toFixed(2)} × ${quantity} (${mode} mode, grade ${d.grade}). Stop ₹${plan.stopPremium.toFixed(2)} / ${d.underlying} ${plan.underlyingStop.toFixed(0)}; targets ₹${plan.target1Premium.toFixed(2)} and ₹${plan.target2Premium.toFixed(2)}. Cancelled automatically if unfilled in ${cfg.entry_timeout_sec}s.`,
      payload: { tradeId, orderId, limit, quantity }, link: '/live',
    });
    return { placed: true, reason: 'order placed', tradeId, orderId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'order failed';
    await query(
      `UPDATE live_trades SET status = 'FAILED', entry_order_status = 'REJECTED', failure_reason = $2, updated_at = now() WHERE id = $1`,
      [tradeId, message.slice(0, 300)],
    );
    await logBroker(tradeId, { event: 'entry_failed', request: req, error: message });
    log.error({ userId, tradeId, err: message }, 'Live entry order failed');
    await notify(userId, {
      kind: 'live', severity: 'warning', title: `Order rejected: ${contract.tradingsymbol}`,
      message, payload: { tradeId }, link: '/live',
    });
    return { placed: false, reason: message, tradeId, orderId: null };
  }
}

// ── order sync ──────────────────────────────────────────────────────────────

/** Apply an exit fill to the row: partial books half; full closes and settles. */
async function applyExitFill(t: LiveTradeRow, qty: number, price: number): Promise<void> {
  const entry = Number(t.entry_price);
  const exits = [...(t.exits ?? []), {
    qty, price, at: new Date().toISOString(), code: t.exit_code ?? 'MANUAL',
    reason: t.exit_code ?? 'manual',
  }];
  const remaining = Math.max(0, t.remaining_qty - qty);
  const full = t.exit_kind === 'FULL' || remaining <= 0;

  if (!full) {
    await query(
      `UPDATE live_trades SET exits = $2::jsonb, remaining_qty = $3, t1_done = TRUE,
              exit_order_id = NULL, exit_order_status = NULL, exit_order_qty = NULL, exit_kind = NULL,
              exit_code = NULL, exit_placed_at = NULL, status = 'OPEN', updated_at = now()
        WHERE id = $1`,
      [t.id, JSON.stringify(exits), remaining],
    );
    await notify(t.user_id, {
      kind: 'live', severity: 'action', title: `${t.tradingsymbol}: half booked at ₹${price.toFixed(2)}`,
      message: `${qty} sold. ${remaining} remain with the stop moved to your entry of ₹${entry.toFixed(2)}; target 2 is ₹${Number(t.target2_premium).toFixed(2)}.`,
      payload: { tradeId: Number(t.id), qty, price }, link: '/live',
    });
    return;
  }

  let gross = 0;
  let costs = 0;
  for (const e of exits) {
    gross += (e.price - entry) * e.qty;
    costs += calculateRoundTripCosts(entry, e.price, e.qty, 'OPT', 'LONG').total;
  }
  const net = gross - costs;
  await query(
    `UPDATE live_trades SET exits = $2::jsonb, remaining_qty = 0, status = 'CLOSED', closed_at = now(),
            exit_order_status = 'COMPLETE', gross_pnl = $3, costs = $4, net_pnl = $5, updated_at = now()
      WHERE id = $1`,
    [t.id, JSON.stringify(exits), gross.toFixed(2), costs.toFixed(2), net.toFixed(2)],
  );
  log.warn({ tradeId: t.id, net: net.toFixed(2), code: t.exit_code }, 'LIVE POSITION CLOSED');
  await notify(t.user_id, {
    kind: 'live', severity: net < 0 ? 'warning' : 'action',
    title: `${t.tradingsymbol} closed: ${net >= 0 ? '+' : ''}₹${net.toFixed(0)} net (${(t.exit_code ?? 'manual').toLowerCase().replace(/_/g, ' ')})`,
    message: `Entry ₹${entry.toFixed(2)}, exit ₹${price.toFixed(2)} × ${qty}. Gross ₹${gross.toFixed(0)}, costs ₹${costs.toFixed(0)}.`,
    payload: { tradeId: Number(t.id), gross, costs, net }, link: '/live',
  });

  // The loss cap is checked on every close, not only before the next entry.
  const cfg = await getLiveConfig(t.user_id);
  if (cfg && cfg.capital !== null && !cfg.halted_reason) {
    const state = await liveState(t.user_id);
    const cap = Number(cfg.capital) * (Number(cfg.max_daily_loss_pct) / 100);
    if (state.netPnlToday <= -cap) {
      await halt(t.user_id, `daily loss cap reached — ₹${Math.abs(state.netPnlToday).toFixed(0)} lost against a ₹${cap.toFixed(0)} cap`);
    }
  }
}

/** Reconcile pending entry and exit orders against the broker's order book. */
export async function syncLiveOrders(userId: string, registry?: ProviderRegistry): Promise<void> {
  const pending = await queryRows<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades
      WHERE user_id = $1 AND ((status = 'PENDING' AND entry_order_id IS NOT NULL) OR status = 'EXITING')`,
    [userId],
  );
  if (pending.length === 0) return;
  const reg = registry ?? (await registryForUser(userId));
  const broker = brokerFor(reg);
  const cfg = await getLiveConfig(userId);
  const book = new Map<string, NormalizedOrder>((await broker.getOrders!()).map((o) => [o.orderId, o]));

  for (const t of pending) {
    try {
      if (t.status === 'PENDING') {
        const o = book.get(t.entry_order_id!);
        if (!o) continue;
        await logBroker(Number(t.id), { event: 'entry_status', order: o });
        if (o.status === 'COMPLETE' && o.averagePrice !== null) {
          const filled = o.filledQuantity > 0 ? o.filledQuantity : t.quantity;
          await query(
            `UPDATE live_trades SET entry_order_status = 'COMPLETE', entry_price = $2, entry_filled_qty = $3,
                    remaining_qty = $3, entry_at = now(), status = 'OPEN', updated_at = now() WHERE id = $1`,
            [t.id, o.averagePrice, filled],
          );
          log.warn({ tradeId: t.id, price: o.averagePrice, filled }, 'LIVE ENTRY FILLED');
          await notify(userId, {
            kind: 'live', severity: 'action', title: `${t.tradingsymbol}: filled at ₹${o.averagePrice.toFixed(2)}`,
            message: `${filled} bought. The exit manager now holds the plan: stop ₹${Number(t.stop_premium).toFixed(2)} / ${t.underlying} ${Number(t.underlying_stop).toFixed(0)}, targets ₹${Number(t.target1_premium).toFixed(2)} and ₹${Number(t.target2_premium).toFixed(2)}.`,
            payload: { tradeId: Number(t.id), price: o.averagePrice, filled }, link: '/live',
          });
        } else if (o.status === 'REJECTED' || o.status === 'CANCELLED') {
          if (o.filledQuantity > 0 && o.averagePrice !== null) {
            // Cancelled after a partial fill: what filled is a position.
            await query(
              `UPDATE live_trades SET entry_order_status = $4, entry_price = $2, entry_filled_qty = $3,
                      remaining_qty = $3, quantity = $3, lots = GREATEST(1, $3 / lot_size), entry_at = now(), status = 'OPEN', updated_at = now() WHERE id = $1`,
              [t.id, o.averagePrice, o.filledQuantity, o.status],
            );
          } else {
            await query(
              `UPDATE live_trades SET entry_order_status = $2, status = 'FAILED', failure_reason = $3, updated_at = now() WHERE id = $1`,
              [t.id, o.status, (o.message ?? o.status.toLowerCase()).slice(0, 300)],
            );
            await notify(userId, {
              kind: 'live', severity: 'warning', title: `${t.tradingsymbol}: entry ${o.status.toLowerCase()}`,
              message: o.message ?? 'No fill. No position was opened.', payload: { tradeId: Number(t.id) }, link: '/live',
            });
          }
        } else {
          const ageSec = (Date.now() - new Date(t.entry_placed_at).getTime()) / 1000;
          if (cfg && ageSec > cfg.entry_timeout_sec) {
            await broker.cancelOrder!(t.entry_order_id!);
            await logBroker(Number(t.id), { event: 'entry_cancelled_timeout', ageSec });
          }
        }
        continue;
      }

      // EXITING
      const o = t.exit_order_id ? book.get(t.exit_order_id) : undefined;
      if (!o) continue;
      await logBroker(Number(t.id), { event: 'exit_status', order: o });
      if (o.status === 'COMPLETE' && o.averagePrice !== null) {
        await applyExitFill(t, o.filledQuantity > 0 ? o.filledQuantity : (t.exit_order_qty ?? t.remaining_qty), o.averagePrice);
      } else if (o.status === 'REJECTED' || o.status === 'CANCELLED') {
        // Back to OPEN; the exit manager re-places on its next pass.
        await query(
          `UPDATE live_trades SET status = 'OPEN', exit_order_id = NULL, exit_order_status = $2, exit_order_qty = NULL,
                  exit_kind = NULL, exit_placed_at = NULL, updated_at = now() WHERE id = $1`,
          [t.id, o.status],
        );
        await notify(userId, {
          kind: 'live', severity: 'warning', title: `${t.tradingsymbol}: exit order ${o.status.toLowerCase()} — retrying`,
          message: o.message ?? 'The broker did not accept the exit. It will be re-sent on the next check.', payload: { tradeId: Number(t.id) }, link: '/live',
        });
      }
    } catch (err) {
      log.error({ err, tradeId: t.id }, 'Live order sync failed for this trade');
    }
  }
}

// ── exit management ─────────────────────────────────────────────────────────

async function placeExit(
  broker: MarketDataProvider, t: LiveTradeRow, qty: number, kind: 'PARTIAL' | 'FULL', code: string, reason: string,
): Promise<boolean> {
  const contract = t.instrument_id ? await instrumentsRepo.getById(Number(t.instrument_id)) : null;
  const token = contract ? instrumentsRepo.providerToken(contract, broker.manifest.id) : undefined;
  if (!contract || !token) {
    log.error({ tradeId: t.id }, 'Cannot place exit: no broker token for the contract');
    return false;
  }
  const req = {
    exchange: contract.exchange, tradingsymbol: contract.tradingsymbol, providerToken: token,
    side: 'SELL' as const, quantity: qty, orderType: 'MARKET' as const, product: t.product, tag: `BT${t.id}X`,
  };
  try {
    const { orderId } = await broker.placeOrder!(req);
    await query(
      `UPDATE live_trades SET status = 'EXITING', exit_order_id = $2, exit_order_status = 'OPEN', exit_order_qty = $3,
              exit_kind = $4, exit_code = $5, exit_placed_at = now(), updated_at = now() WHERE id = $1`,
      [t.id, orderId, qty, kind, code],
    );
    await logBroker(Number(t.id), { event: 'exit_placed', request: req, orderId, code, reason });
    log.warn({ tradeId: t.id, orderId, qty, code }, 'LIVE EXIT ORDER PLACED');
    await notify(t.user_id, {
      kind: 'live', severity: code === 'STOP' || code === 'INVALIDATED' ? 'warning' : 'action',
      title: `${t.tradingsymbol}: ${kind === 'PARTIAL' ? 'booking half' : 'exiting'} — ${code.toLowerCase().replace(/_/g, ' ')}`,
      message: reason, payload: { tradeId: Number(t.id), orderId, qty, code }, link: '/live',
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'exit failed';
    await logBroker(Number(t.id), { event: 'exit_failed', request: req, error: message });
    log.error({ tradeId: t.id, err: message }, 'Live exit order failed');
    await notify(t.user_id, {
      kind: 'live', severity: 'warning', title: `${t.tradingsymbol}: EXIT ORDER FAILED`,
      message: `${message}. The position is still open — close it from the broker app if this repeats.`,
      payload: { tradeId: Number(t.id) }, link: '/live',
    });
    return false;
  }
}

/** Apply the plan to every open live position. */
export async function manageLiveExits(userId: string, registry?: ProviderRegistry): Promise<void> {
  const open = await queryRows<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades WHERE user_id = $1 AND status = 'OPEN'`, [userId],
  );
  if (open.length === 0) return;
  const reg = registry ?? (await registryForUser(userId));
  const broker = brokerFor(reg);
  const cfg = await getLiveConfig(userId);
  const squareOffMin = cfg?.square_off_min ?? 915;
  const spots = new Map<string, number | null>();

  for (const t of open) {
    try {
      const contract = t.instrument_id ? await instrumentsRepo.getById(Number(t.instrument_id)) : null;
      if (!contract) continue;
      const quote = await getQuote(reg, contract);
      if (!isAvailable(quote)) continue;
      const premium = quote.value.ltp;

      if (!spots.has(t.underlying)) {
        const row = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(t.underlying));
        const sq = row ? await getQuote(reg, row) : null;
        spots.set(t.underlying, sq && isAvailable(sq) ? sq.value.ltp : null);
      }
      const spot = spots.get(t.underlying) ?? null;

      const maxFav = Math.max(Number(t.max_favourable_premium ?? premium), premium);
      const maxAdv = Math.min(Number(t.max_adverse_premium ?? premium), premium);
      await query(
        `UPDATE live_trades SET last_premium = $2, max_favourable_premium = $3, max_adverse_premium = $4, updated_at = now() WHERE id = $1`,
        [t.id, premium, maxFav, maxAdv],
      );

      const action = decideLiveExit({
        action: t.action, expiry: t.expiry, product: t.product,
        entryPremium: Number(t.entry_price), stopPremium: Number(t.stop_premium),
        target1Premium: Number(t.target1_premium), target2Premium: Number(t.target2_premium),
        underlyingStop: Number(t.underlying_stop), remainingQty: t.remaining_qty, lotSize: t.lot_size,
        t1Done: t.t1_done, scaleOut: t.scale_out,
      }, { premium, spot, now: new Date(), squareOffMin });

      if (action.kind === 'HOLD') continue;
      await placeExit(broker, t, action.qty, action.kind === 'BOOK_HALF' ? 'PARTIAL' : 'FULL', action.code, action.reason);
    } catch (err) {
      log.error({ err, tradeId: t.id }, 'Live exit management failed for this trade');
    }
  }
}

/** Exit an open live position at market for a stated reason (the news guard). */
export async function exitLive(userId: string, tradeId: number, code: string, reason: string): Promise<boolean> {
  const t = await queryOne<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades WHERE id = $1 AND user_id = $2 AND status = 'OPEN'`, [tradeId, userId],
  );
  if (!t) return false;
  const broker = brokerFor(await registryForUser(userId));
  return placeExit(broker, t, t.remaining_qty, 'FULL', code, reason);
}

/** Move the stop on an open live position — only ever upward. */
export async function tightenLiveStop(tradeId: number, newStop: number): Promise<void> {
  await query(
    `UPDATE live_trades SET stop_premium = GREATEST(stop_premium, $2), updated_at = now() WHERE id = $1 AND status = 'OPEN'`,
    [tradeId, newStop],
  );
}

/** Close one position (or cancel its pending entry) on the user's instruction. */
export async function closeLive(userId: string, tradeId: number): Promise<{ ok: boolean; reason: string }> {
  const t = await queryOne<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades WHERE id = $1 AND user_id = $2`, [tradeId, userId],
  );
  if (!t) return { ok: false, reason: 'Trade not found.' };
  const registry = await registryForUser(userId);
  const broker = brokerFor(registry);
  if (t.status === 'PENDING' && t.entry_order_id) {
    await broker.cancelOrder!(t.entry_order_id);
    await logBroker(tradeId, { event: 'entry_cancelled_by_user' });
    return { ok: true, reason: 'Cancel sent. The order book sync will confirm it.' };
  }
  if (t.status === 'OPEN') {
    const placed = await placeExit(broker, t, t.remaining_qty, 'FULL', 'MANUAL', 'Closed from the Live Trading page.');
    return placed ? { ok: true, reason: 'Exit order placed.' } : { ok: false, reason: 'The exit order was not accepted.' };
  }
  return { ok: false, reason: `Trade is ${t.status.toLowerCase()}; nothing to close.` };
}

/**
 * Kill switch: cancel every pending entry, flatten every open position at
 * market, and refuse all new orders until reset.
 */
export async function killSwitch(userId: string): Promise<{ cancelled: number; exits: number }> {
  await ensureConfig(userId);
  await query(
    `UPDATE live_trade_config SET kill_switch = TRUE, armed_until = NULL, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
  log.warn({ userId }, 'LIVE KILL SWITCH ENGAGED');
  const active = await queryRows<LiveTradeRow>(
    `SELECT ${TRADE_SELECT} FROM live_trades WHERE user_id = $1 AND status IN ('PENDING','OPEN')`, [userId],
  );
  const registry = await registryForUser(userId);
  const broker = brokerFor(registry);
  let cancelled = 0;
  let exits = 0;
  for (const t of active) {
    try {
      if (t.status === 'PENDING' && t.entry_order_id) {
        await broker.cancelOrder!(t.entry_order_id);
        await logBroker(Number(t.id), { event: 'entry_cancelled_kill' });
        cancelled += 1;
      } else if (t.status === 'OPEN') {
        if (await placeExit(broker, t, t.remaining_qty, 'FULL', 'KILL', 'Kill switch engaged.')) exits += 1;
      }
    } catch (err) {
      log.error({ err, tradeId: t.id }, 'Kill switch action failed for this trade');
    }
  }
  await notify(userId, {
    kind: 'live', severity: 'warning', title: 'Kill switch engaged',
    message: `${cancelled} pending order(s) cancelled, ${exits} position(s) sent to market. No new orders until you reset.`,
    link: '/live',
  });
  return { cancelled, exits };
}

export async function resetKillSwitch(userId: string): Promise<void> {
  await query(
    `UPDATE live_trade_config SET kill_switch = FALSE, halted_reason = NULL, halted_at = NULL, updated_at = now() WHERE user_id = $1`,
    [userId],
  );
  log.warn({ userId }, 'Live kill switch reset');
}

// ── reporting ───────────────────────────────────────────────────────────────

export interface LivePerformance {
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossPnl: number;
  costs: number;
  netPnl: number;
  best: number | null;
  worst: number | null;
  profitFactor: number | null;
  todayNet: number;
  caveat: string;
}

export async function livePerformance(userId: string): Promise<LivePerformance> {
  const r = await queryOne<Record<string, string | null>>(
    `SELECT COUNT(*) FILTER (WHERE status = 'CLOSED')::text AS closed,
            COUNT(*) FILTER (WHERE status = 'CLOSED' AND net_pnl > 0)::text AS wins,
            COUNT(*) FILTER (WHERE status = 'CLOSED' AND net_pnl <= 0)::text AS losses,
            COALESCE(SUM(gross_pnl), 0)::text AS gross, COALESCE(SUM(costs), 0)::text AS costs,
            COALESCE(SUM(net_pnl), 0)::text AS net, MAX(net_pnl)::text AS best, MIN(net_pnl)::text AS worst,
            COALESCE(SUM(net_pnl) FILTER (WHERE net_pnl > 0), 0)::text AS gp,
            COALESCE(ABS(SUM(net_pnl) FILTER (WHERE net_pnl <= 0)), 0)::text AS gl,
            COALESCE(SUM(net_pnl) FILTER (WHERE closed_at::date = CURRENT_DATE), 0)::text AS today
       FROM live_trades WHERE user_id = $1`,
    [userId],
  );
  const closed = Number(r?.['closed'] ?? 0);
  const wins = Number(r?.['wins'] ?? 0);
  const gl = Number(r?.['gl'] ?? 0);
  return {
    closed, wins, losses: Number(r?.['losses'] ?? 0),
    winRate: closed > 0 ? (wins / closed) * 100 : null,
    grossPnl: Number(r?.['gross'] ?? 0), costs: Number(r?.['costs'] ?? 0), netPnl: Number(r?.['net'] ?? 0),
    best: r?.['best'] === null || r?.['best'] === undefined ? null : Number(r['best']),
    worst: r?.['worst'] === null || r?.['worst'] === undefined ? null : Number(r['worst']),
    profitFactor: gl > 0 ? Number(r?.['gp'] ?? 0) / gl : null,
    todayNet: Number(r?.['today'] ?? 0),
    caveat: closed < 30
      ? `${closed} closed live trade(s). Nothing can be concluded about the strategy from this few; the spread of outcomes at this sample size dwarfs any edge.`
      : 'Net figures are after the Indian cost stack on both legs. Fills are the broker\'s actual fills.',
  };
}

// ── worker entry points ─────────────────────────────────────────────────────

/** Every user with live trading configured and anything in flight. */
export async function sweepLiveOrders(): Promise<void> {
  const users = await queryRows<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM live_trades WHERE status IN ('PENDING','OPEN','EXITING')`,
  );
  for (const u of users) {
    try {
      const registry = await registryForUser(u.user_id);
      await syncLiveOrders(u.user_id, registry);
      await manageLiveExits(u.user_id, registry);
    } catch (err) {
      log.error({ err, userId: u.user_id }, 'Live order sweep failed for this user');
    }
  }
}

/** AUTO mode: evaluate each armed user's underlyings and place what qualifies. */
export async function sweepLiveAuto(): Promise<void> {
  const users = await queryRows<LiveConfigRow>(
    `SELECT * FROM live_trade_config WHERE mode = 'AUTO' AND armed_until > now() AND kill_switch = FALSE AND halted_reason IS NULL`,
  );
  for (const cfg of users) {
    const skipped: string[] = [];
    let placed = 0;
    for (const underlying of cfg.underlyings) {
      try {
        const r = await executeLive(cfg.user_id, underlying, 'AUTO');
        if (r.placed) placed += 1; else skipped.push(`${underlying}: ${r.reason}`);
      } catch (err) {
        skipped.push(`${underlying}: ${err instanceof Error ? err.message.slice(0, 120) : 'error'}`);
      }
    }
    await query(
      `UPDATE live_trade_config SET last_sweep_at = now(), last_sweep_result = $2::jsonb, updated_at = now() WHERE user_id = $1`,
      [cfg.user_id, JSON.stringify({ placed, skipped })],
    );
  }
}
