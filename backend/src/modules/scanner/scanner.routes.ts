import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, timeframeSchema, rateLimit,
} from '../../middleware/index.js';
import { registryForUser } from '../../providers/registry.js';
import { queryOne } from '../../db/pool.js';
import { runScan, getRecentIdeas } from './scanner.service.js';
import type { RiskConfig } from '../../analysis/risk/positionSizing.js';
import type { SetupKind } from '../../analysis/signals/engine.js';

export const scannerRouter = Router();
scannerRouter.use(requireAuth);

/** The user's configured risk budget, used to size every idea returned. */
async function loadRiskConfig(userId: string): Promise<RiskConfig | undefined> {
  const row = await queryOne<{
    capital: number; max_risk_per_trade_pct: number;
    max_daily_loss_pct: number; max_open_positions: number;
  }>(
    `SELECT capital, max_risk_per_trade_pct, max_daily_loss_pct, max_open_positions
       FROM user_settings WHERE user_id = $1`,
    [userId],
  );
  if (!row) return undefined;
  return {
    capital: row.capital,
    maxRiskPerTradePct: row.max_risk_per_trade_pct,
    maxDailyLossPct: row.max_daily_loss_pct,
    maxOpenPositions: row.max_open_positions,
  };
}

const SETUPS = ['BREAKOUT', 'PULLBACK', 'MOMENTUM', 'REVERSAL', 'BREAKDOWN', 'RANGE'] as const;

const scanQuery = z.object({
  setup: z.string().optional(),
  tf: timeframeSchema,
  universe: z.string().max(40).default('NIFTY50'),
  minStrength: z.coerce.number().min(0).max(100).default(50),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  maxSymbols: z.coerce.number().int().min(10).max(500).default(200),
});

/** A scan is CPU- and DB-heavy; rate limit it separately from ordinary reads. */
const scanLimiter = rateLimit({ bucket: 'scanner', limit: 20, windowSeconds: 300 });

scannerRouter.get(
  '/swing',
  scanLimiter,
  validate(scanQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof scanQuery>;
    const registry = await registryForUser(req.user!.id);
    const riskConfig = await loadRiskConfig(req.user!.id);

    const setups = q.setup
      ? (q.setup.split(',').map((s) => s.trim().toUpperCase())
          .filter((s): s is SetupKind => (SETUPS as readonly string[]).includes(s)))
      : undefined;

    respond(res, await runScan(registry, {
      ...(setups ? { setups } : {}),
      timeframe: q.tf,
      universe: q.universe,
      minStrength: q.minStrength,
      limit: q.limit,
      maxSymbols: q.maxSymbols,
    }, riskConfig));
  }),
);

scannerRouter.get(
  '/breakout',
  scanLimiter,
  validate(scanQuery, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof scanQuery>;
    const registry = await registryForUser(req.user!.id);
    const riskConfig = await loadRiskConfig(req.user!.id);
    respond(res, await runScan(registry, {
      setups: ['BREAKOUT', 'BREAKDOWN'],
      timeframe: q.tf,
      universe: q.universe,
      minStrength: q.minStrength,
      limit: q.limit,
      maxSymbols: q.maxSymbols,
    }, riskConfig));
  }),
);

scannerRouter.get(
  '/ideas',
  asyncHandler(async (_req, res) => {
    const rows = await getRecentIdeas(20);
    respond(res, rows, {
      note: rows.length === 0
        ? 'No stored ideas yet. Run a scan, or wait for the scheduled scanner sweep.'
        : undefined,
      disclaimer:
        'Stored research observations from previous scans. Levels were computed at generation time and may no longer reflect current structure.',
    });
  }),
);
