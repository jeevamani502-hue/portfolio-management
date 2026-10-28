/**
 * Hero Zero service — gathers what the expiry-day engine wants, runs it for
 * each configured underlying, and places the order through the same live
 * trade plumbing as the checklist strategy (same broker log, same exit
 * manager, same kill switch).
 *
 * Its guards are the live guards minus the "no fresh buys on expiry day"
 * rule, which this strategy exists to break deliberately, plus its own
 * per-day attempt cap and the stated budget.
 */
import { queryOne, queryRows } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { registryForUser, type ProviderRegistry } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getCandles, marketStatus } from '../market/marketData.service.js';
import { getExpiries, getOptionChain, underlyingInstrumentFor } from '../options/options.service.js';
import { isAvailable } from '../../utils/sourced.js';
import { toIst } from '../../utils/time.js';
import { buildSnapshot } from '../../analysis/snapshot.js';
import type { TechnicalSnapshot } from '../../analysis/snapshot.js';
import type { Candle } from '../../analysis/indicators/index.js';
import { calendarDaysToExpiry } from '../../analysis/options/decisionEngine.js';
import {
  buildHeroZeroDecision, HERO_ZERO_WARNING,
  type HeroZeroConfig, type HeroZeroDecision,
} from '../../analysis/options/heroZero.js';
import {
  getLiveConfig, blockersFor, brokerFor, refreshCapital, openLiveTrade,
  type LiveConfigRow, type ExecuteResult,
} from './live.service.js';
import type { LiveBlocker } from '../../analysis/options/liveGuards.js';

const log = logger.child({ module: 'hero-zero' });

export const heroZeroConfigOf = (c: LiveConfigRow): HeroZeroConfig => ({
  budget: Number(c.hero_zero_budget),
  minPremium: Number(c.hero_zero_min_premium),
  maxPremium: Number(c.hero_zero_max_premium),
  maxLots: c.hero_zero_max_lots,
  windowStartMin: c.hero_zero_window_start_min,
  windowEndMin: c.hero_zero_window_end_min,
  squareOffMin: c.hero_zero_square_off_min,
  stopPct: Number(c.hero_zero_stop_pct),
  targetMultiple: Number(c.hero_zero_target_multiple),
  minAgree: c.hero_zero_min_agree,
});

export interface HeroZeroEvaluation {
  decision: HeroZeroDecision | null;
  /** Why no decision could be built. */
  error: string | null;
}

/** Build the decision for one underlying from live data. Pure beyond the fetches. */
export async function evaluateHeroZero(
  registry: ProviderRegistry,
  underlying: string,
  cfg: HeroZeroConfig,
  now = new Date(),
): Promise<HeroZeroEvaluation> {
  const sym = underlying.toUpperCase();
  const expiries = await getExpiries(registry, sym);
  if (!isAvailable(expiries) || expiries.value.length === 0) return { decision: null, error: `No option expiries are listed for ${sym}.` };
  // The nearest expiry; the engine's own gate says whether that is today.
  const expiry = [...expiries.value].sort()[0]!;
  const daysToExpiry = calendarDaysToExpiry(expiry, now);

  const chain = await getOptionChain(registry, sym, expiry);
  if (!isAvailable(chain)) return { decision: null, error: chain.detail ?? chain.reason };

  const instrument = await instrumentsRepo.resolveSymbol(underlyingInstrumentFor(sym));
  if (!instrument) return { decision: null, error: `${sym} is not in the instrument master.` };

  let intraday: TechnicalSnapshot | null = null;
  let todayCandles: Candle[] = [];
  try {
    const candles = await getCandles(registry, instrument, '5m', { bars: 160 });
    const today = toIst(now).dateKey;
    todayCandles = candles.candles.filter((c) => toIst(new Date(c.ts)).dateKey === today);
    if (candles.candles.length >= 30) intraday = buildSnapshot(instrument.tradingsymbol, '5m', candles.candles);
  } catch (err) {
    log.debug({ sym, err: (err as Error).message }, 'Hero Zero: 5m history unavailable');
  }

  const status = await marketStatus();
  const decision = buildHeroZeroDecision({
    underlying: sym, expiry, daysToExpiry, chain: chain.value, intraday, todayCandles,
    market: { phase: status.phase, minutesOfDay: toIst(now).minutesOfDay }, cfg, now,
  });
  return { decision, error: null };
}

export interface HeroZeroScan {
  enabled: boolean;
  config: HeroZeroConfig;
  attemptsToday: number;
  blockers: LiveBlocker[];
  results: Array<{ underlying: string } & HeroZeroEvaluation>;
  warning: string;
}

async function attemptsToday(userId: string): Promise<number> {
  const r = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM live_trades
      WHERE user_id = $1 AND strategy = 'HERO_ZERO' AND status <> 'FAILED'
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date`,
    [userId],
  );
  return Number(r?.n ?? 0);
}

/** Everything the Hero Zero card shows: settings, today's attempts, and a decision per underlying. */
export async function heroZeroScan(userId: string): Promise<HeroZeroScan | null> {
  const cfg = await getLiveConfig(userId);
  if (!cfg) return null;
  const hz = heroZeroConfigOf(cfg);
  const [attempts, blockers] = await Promise.all([attemptsToday(userId), blockersFor(userId, cfg, null)]);
  const registry = await registryForUser(userId);
  const results: HeroZeroScan['results'] = [];
  for (const underlying of cfg.underlyings) {
    try {
      results.push({ underlying, ...(await evaluateHeroZero(registry, underlying, hz)) });
    } catch (err) {
      results.push({ underlying, decision: null, error: err instanceof Error ? err.message : 'evaluation failed' });
    }
  }
  return { enabled: cfg.hero_zero_enabled, config: hz, attemptsToday: attempts, blockers, results, warning: HERO_ZERO_WARNING };
}

/** Place the Hero Zero order for one underlying, if the engine says Enter and every cap allows it. */
export async function executeHeroZero(
  userId: string,
  underlying: string,
  mode: 'CONFIRM' | 'AUTO',
): Promise<ExecuteResult> {
  const none = (reason: string): ExecuteResult => ({ placed: false, reason, tradeId: null, orderId: null });
  const cfg = await getLiveConfig(userId);
  if (!cfg) return none('Live trading is not set up.');
  if (!cfg.hero_zero_enabled) return none('Hero Zero is switched off in your settings.');
  if (mode === 'CONFIRM' && cfg.mode === 'OFF') return none('Live trading is switched off.');
  if (mode === 'AUTO' && cfg.mode !== 'AUTO') return none('Not in AUTO mode.');

  // Live guards, minus the expiry-day rule: pass no days-to-expiry so that one is skipped.
  const early = await blockersFor(userId, cfg, null);
  if (early.length > 0) return none(early[0]!.detail);
  const hz = heroZeroConfigOf(cfg);
  const attempts = await attemptsToday(userId);
  if (attempts >= cfg.hero_zero_max_trades_per_day) return none(`${attempts} Hero Zero attempt(s) today, which is your cap.`);

  const registry = await registryForUser(userId);
  let broker;
  try { broker = brokerFor(registry, cfg.broker); } catch (err) { return none((err as Error).message); }

  const { capital } = await refreshCapital(userId);
  if (!(capital > 0)) return none('The broker reports no available cash to trade with.');
  if (hz.budget > capital) return none(`The ₹${hz.budget} Hero Zero budget is more than the ₹${capital.toFixed(0)} available at the broker.`);

  const ev = await evaluateHeroZero(registry, underlying, hz);
  if (!ev.decision) return none(ev.error ?? 'could not evaluate');
  const d = ev.decision;
  if (d.stance !== 'ENTER' || !d.candidate || !d.side) return none(d.summary);

  const late = await blockersFor(userId, cfg, null);
  if (late.length > 0) return none(late[0]!.detail);

  const c = d.candidate;
  return openLiveTrade({
    userId, mode, broker, signalId: null, strategy: 'HERO_ZERO',
    underlying: d.underlying, expiry: d.expiry, strike: c.strike, optionType: c.optionType, action: c.action,
    product: 'INTRADAY', lotSize: c.lotSize, lots: c.lots, quantity: c.quantity, limit: c.limit,
    grade: 'HZ', score: d.agreeing,
    stopPremium: c.stopPremium, target1Premium: c.target1Premium, target2Premium: c.target2Premium,
    underlyingStop: c.underlyingStop, underlyingTarget1: c.underlyingTarget1, underlyingTarget2: c.underlyingTarget2,
    plan: {
      strategy: 'HERO_ZERO', squareOffMin: hz.squareOffMin, budget: hz.budget, stopPct: hz.stopPct, targetMultiple: hz.targetMultiple,
      factors: d.factors, gates: d.gates, summary: d.summary, warning: d.warning, spot: d.spot, otmPct: c.otmPct,
    },
    scaleOut: c.lots >= 2,
    entryTimeoutSec: cfg.entry_timeout_sec,
    notifyTitle: `Hero Zero: buy ${c.lots} lot(s) ${d.underlying} ${c.strike} ${c.optionType}`,
    notifyMessage: `Limit ₹${c.limit.toFixed(2)} × ${c.quantity}, ₹${c.outlay.toFixed(0)} of the ₹${hz.budget} budget, all of it at risk. ${d.agreeing} of ${d.readable} conditions agree. Stop ₹${c.stopPremium.toFixed(2)}, targets ₹${c.target1Premium.toFixed(2)} and ₹${c.target2Premium.toFixed(2)}, flat by ${String(Math.floor(hz.squareOffMin / 60)).padStart(2, '0')}:${String(hz.squareOffMin % 60).padStart(2, '0')} IST.`,
  });
}

/** AUTO mode: for every armed user with Hero Zero on, try each underlying. Called by the worker. */
export async function sweepHeroZeroAuto(): Promise<void> {
  const users = await queryRows<LiveConfigRow>(
    `SELECT * FROM live_trade_config
      WHERE mode = 'AUTO' AND hero_zero_enabled = TRUE AND armed_until > now() AND kill_switch = FALSE AND halted_reason IS NULL`,
  );
  for (const cfg of users) {
    for (const underlying of cfg.underlyings) {
      try {
        const r = await executeHeroZero(cfg.user_id, underlying, 'AUTO');
        if (r.placed) log.warn({ userId: cfg.user_id, underlying, tradeId: r.tradeId }, 'HERO ZERO ORDER PLACED (AUTO)');
        else log.debug({ userId: cfg.user_id, underlying, reason: r.reason }, 'Hero Zero: no order');
      } catch (err) {
        log.error({ err, userId: cfg.user_id, underlying }, 'Hero Zero auto sweep failed');
      }
    }
  }
}
