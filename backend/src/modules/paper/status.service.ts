/**
 * "What is the engine doing right now, and why has nothing traded?"
 *
 * That question was unanswerable from the UI: the switch said Running, no
 * positions appeared, and there was no way to tell whether the engine had
 * looked and declined, never looked at all, or quietly failed. Running and
 * structurally-unable-to-trade looked identical.
 *
 * So this checks each precondition in the order the engine itself would hit
 * them and reports the first one that blocks, with the arithmetic. The most
 * common blocker is not a bug — it is capital too small to fund one lot —
 * and that is worth saying in rupees rather than leaving someone to wonder.
 */
import { queryOne, queryRows } from '../../db/pool.js';
import { registryForUser } from '../../providers/registry.js';
import { marketStatus } from '../market/marketData.service.js';
import { redis } from '../../cache/redis.js';
import { K } from '../../cache/keys.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getConfig, type PaperConfig } from './paper.service.js';

/** How the engine is behaving overall. */
export type EngineState = 'NOT_SET_UP' | 'STOPPED' | 'HALTED' | 'WAITING' | 'WATCHING';

export interface Blocker {
  /** Short machine-readable cause. */
  code: string;
  /** What is wrong, in plain words, with the numbers. */
  detail: string;
  /** What the user can do about it, when there is something. */
  fix?: string;
}

export interface PaperStatus {
  state: EngineState;
  /** One line a beginner can read and act on. */
  headline: string;
  /** Everything currently preventing a trade, most fundamental first. */
  blockers: Blocker[];
  marketPhase: string;
  marketOpen: boolean;
  /** Whether a live price feed is currently attached. */
  feedConnected: boolean;
  capital: number | null;
  /** What one lot of the cheapest watched underlying would actually cost. */
  lotEconomics: Array<{
    underlying: string;
    lotSize: number | null;
    riskBudget: number;
    note: string;
  }>;
  watching: string[];
  openPositions: number;
  tradesToday: number;
  lastSweepAt: string | null;
  lastSweepSummary: string | null;
  /** Reasons the last sweep gave for not trading each underlying. */
  lastSweepSkipped: string[];
  /** Seconds until the worker looks again; null when it is not running. */
  nextSweepInSeconds: number | null;
}

/** The worker's paper sweep interval, mirrored so the UI can count down. */
const SWEEP_INTERVAL_SEC = 180;

export async function getPaperStatus(userId: string): Promise<PaperStatus> {
  const cfg = await getConfig(userId);
  const market = await marketStatus().catch(() => null);
  const feedConnected = (await redis.get(K.feedStatus).catch(() => null)) === 'connected';

  const base: PaperStatus = {
    state: 'NOT_SET_UP',
    headline: '',
    blockers: [],
    marketPhase: market?.phase ?? 'UNKNOWN',
    marketOpen: market?.isOpen ?? false,
    feedConnected,
    capital: null,
    lotEconomics: [],
    watching: [],
    openPositions: 0,
    tradesToday: 0,
    lastSweepAt: null,
    lastSweepSummary: null,
    lastSweepSkipped: [],
    nextSweepInSeconds: null,
  };

  if (!cfg) {
    return {
      ...base,
      headline: 'Paper trading is not set up yet. Enter the capital the strategy may use to begin.',
      blockers: [{
        code: 'no_config',
        detail: 'No capital has been set, so no position can be sized.',
        fix: 'Enter an amount below and press Start paper trading.',
      }],
    };
  }

  const capital = Number(cfg.capital);
  const counts = await queryOne<{ open: string; today: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'OPEN')::text AS open,
       COUNT(*) FILTER (WHERE entry_at::date = CURRENT_DATE)::text AS today
     FROM paper_trades WHERE user_id = $1`,
    [userId],
  );

  const sweep = await queryOne<{ last_sweep_at: Date | null; last_sweep_result: unknown }>(
    `SELECT last_sweep_at, last_sweep_result FROM paper_trade_config WHERE user_id = $1`,
    [userId],
  );

  const result = (sweep?.last_sweep_result ?? null) as
    | { considered?: number; opened?: number; skipped?: string[] }
    | null;

  const status: PaperStatus = {
    ...base,
    capital,
    watching: cfg.underlyings,
    openPositions: Number(counts?.open ?? 0),
    tradesToday: Number(counts?.today ?? 0),
    lastSweepAt: sweep?.last_sweep_at?.toISOString() ?? null,
    lastSweepSummary: result
      ? `Looked at ${result.considered ?? 0} underlying(s), opened ${result.opened ?? 0}.`
      : null,
    lastSweepSkipped: result?.skipped ?? [],
    lotEconomics: await lotEconomics(userId, cfg, capital),
  };

  const blockers: Blocker[] = [];

  // ── ordered exactly as the engine hits them ──────────────────────────────

  if (cfg.halted_reason) {
    blockers.push({
      code: 'halted',
      detail: cfg.halted_reason,
      fix: 'Press Start paper trading to clear the halt — that is you overruling your own limit, so do it deliberately.',
    });
  }

  if (!cfg.is_enabled) {
    blockers.push({
      code: 'stopped',
      detail: 'The engine is switched off, so it is not looking for trades.',
      fix: 'Press Start paper trading.',
    });
  }

  const registry = await registryForUser(userId);
  const configured = registry.all().filter((p) => p.isConfigured());
  if (configured.length === 0) {
    blockers.push({
      code: 'no_provider',
      detail: 'No broker is connected, so there are no prices to trade against.',
      fix: 'Settings → Market data providers.',
    });
  }

  if (!market?.isOpen) {
    blockers.push({
      code: 'market_closed',
      detail: `The market is ${market?.phase ?? 'closed'}. The engine only opens positions during a live session.`,
      fix: 'Nothing to do — it resumes at the next open.',
    });
  }

  // The commonest real blocker, and the one nobody guesses.
  for (const econ of status.lotEconomics) {
    if (econ.lotSize && econ.riskBudget > 0 && econ.note.startsWith('Too small')) {
      blockers.push({ code: 'capital_too_small', detail: econ.note, fix: 'Raise the capital, or raise risk per trade.' });
    }
  }

  if (status.openPositions >= cfg.max_open_positions) {
    blockers.push({
      code: 'position_limit',
      detail: `${status.openPositions} position(s) open, which is your limit of ${cfg.max_open_positions}.`,
      fix: 'Close one, or raise the limit.',
    });
  }

  if (status.tradesToday >= cfg.max_trades_per_day) {
    blockers.push({
      code: 'daily_trade_limit',
      detail: `${status.tradesToday} trade(s) today, which is your limit of ${cfg.max_trades_per_day}.`,
      fix: 'It resets tomorrow.',
    });
  }

  // ── overall state and the one-line headline ──────────────────────────────

  if (cfg.halted_reason) {
    status.state = 'HALTED';
    status.headline = `Halted: ${cfg.halted_reason}`;
  } else if (!cfg.is_enabled) {
    status.state = 'STOPPED';
    status.headline = 'Stopped. The engine is not looking for trades.';
  } else if (blockers.length > 0) {
    status.state = 'WAITING';
    status.headline = `Running, but it cannot trade right now — ${blockers[0]!.detail}`;
  } else {
    status.state = 'WATCHING';
    status.headline = status.lastSweepSkipped.length > 0
      ? `Watching ${cfg.underlyings.join(', ')}. Last check found no setup that met your rules.`
      : `Watching ${cfg.underlyings.join(', ')} for a setup.`;
  }

  if (cfg.is_enabled && market?.isOpen) {
    const since = sweep?.last_sweep_at ? (Date.now() - sweep.last_sweep_at.getTime()) / 1000 : null;
    status.nextSweepInSeconds =
      since === null ? SWEEP_INTERVAL_SEC : Math.max(0, Math.round(SWEEP_INTERVAL_SEC - since));
  }

  status.blockers = blockers;
  return status;
}

/**
 * What one lot of each watched underlying would cost, against the risk budget.
 *
 * This is the calculation people get wrong: a NIFTY option lot is 65
 * contracts, so a ₹20 premium is ₹1,300 committed. Someone with ₹15,000 at
 * 3% has a ₹450 risk budget and will never fund a single lot — the engine
 * declines every time and looks broken.
 */
async function lotEconomics(
  userId: string,
  cfg: PaperConfig,
  capital: number,
): Promise<PaperStatus['lotEconomics']> {
  const riskBudget = capital * (Number(cfg.risk_per_trade_pct) / 100);
  const out: PaperStatus['lotEconomics'] = [];

  for (const underlying of cfg.underlyings) {
    const rows = await queryRows<{ lot_size: number }>(
      `SELECT DISTINCT lot_size FROM instruments
        WHERE underlying = $1 AND instrument_type IN ('CE','PE') AND lot_size > 1
        ORDER BY lot_size LIMIT 1`,
      [underlying.toUpperCase()],
    );
    const lotSize = rows[0]?.lot_size ?? null;

    if (!lotSize) {
      out.push({ underlying, lotSize: null, riskBudget, note: 'No option contracts found for this underlying yet.' });
      continue;
    }

    // The constraint that actually decides whether a trade is possible:
    // the risk budget divided by the lot size is the widest stop, per
    // contract, that can be afforded. Saying it this way lets someone see
    // immediately which options are within reach and which never will be.
    const maxStopPerContract = riskBudget / lotSize;
    // A sane stop is a meaningful fraction of the premium, so roughly four
    // times the stop is the most expensive option that can be sized.
    const affordablePremium = maxStopPerContract * 4;

    out.push({
      underlying,
      lotSize,
      riskBudget,
      note:
        maxStopPerContract < 1
          ? `Too small to trade ${underlying}. One lot is ${lotSize} contracts, and a ` +
            `₹${Math.round(riskBudget).toLocaleString('en-IN')} risk budget allows a stop of only ` +
            `₹${maxStopPerContract.toFixed(2)} per contract — narrower than one tick on most options.`
          : `One ${underlying} lot is ${lotSize} contracts. Your ₹${Math.round(riskBudget).toLocaleString('en-IN')} ` +
            `risk budget (${cfg.risk_per_trade_pct}% of ₹${capital.toLocaleString('en-IN')}) allows a stop of about ` +
            `₹${maxStopPerContract.toFixed(2)} per contract, so options priced up to roughly ` +
            `₹${Math.round(affordablePremium)} can be sized. Pricier ones will be declined.`,
    });
  }

  void userId;
  return out;
}
