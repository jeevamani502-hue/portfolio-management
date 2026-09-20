/**
 * Risk endpoints: position sizing and risk/reward, both fully explained.
 *
 * These are pure arithmetic over user-supplied inputs, so they work with no
 * market-data provider configured at all — which matters, because position
 * sizing is the one thing a trader should never skip.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { badRequest } from '../../utils/errors.js';
import { queryOne } from '../../db/pool.js';
import {
  calculatePositionSize, calculateRiskReward, checkDailyLoss, atrStop,
  InvalidRiskInput, type RiskConfig,
} from '../../analysis/risk/positionSizing.js';

export const riskRouter = Router();
riskRouter.use(requireAuth);

async function riskConfigFor(userId: string, override?: Partial<RiskConfig>): Promise<RiskConfig> {
  const row = await queryOne<{
    capital: number; max_risk_per_trade_pct: number;
    max_daily_loss_pct: number; max_open_positions: number;
  }>(
    `SELECT capital, max_risk_per_trade_pct, max_daily_loss_pct, max_open_positions
       FROM user_settings WHERE user_id = $1`,
    [userId],
  );

  return {
    capital: override?.capital ?? row?.capital ?? 500000,
    maxRiskPerTradePct: override?.maxRiskPerTradePct ?? row?.max_risk_per_trade_pct ?? 1,
    maxDailyLossPct: override?.maxDailyLossPct ?? row?.max_daily_loss_pct ?? 3,
    maxOpenPositions: override?.maxOpenPositions ?? row?.max_open_positions ?? 10,
  };
}

const sizingSchema = z.object({
  entry: z.number().positive(),
  stop: z.number().positive(),
  target1: z.number().positive().optional(),
  target2: z.number().positive().optional(),
  lotSize: z.number().int().positive().default(1),
  capital: z.number().positive().optional(),
  maxRiskPerTradePct: z.number().positive().max(100).optional(),
  maxPositionPctOfCapital: z.number().positive().max(100).default(25),
});

riskRouter.post(
  '/position-size',
  validate(sizingSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof sizingSchema>;
    const config = await riskConfigFor(req.user!.id, {
      ...(body.capital !== undefined ? { capital: body.capital } : {}),
      ...(body.maxRiskPerTradePct !== undefined
        ? { maxRiskPerTradePct: body.maxRiskPerTradePct }
        : {}),
    });

    try {
      const sizing = calculatePositionSize({
        entry: body.entry,
        stop: body.stop,
        config,
        lotSize: body.lotSize,
        maxPositionPctOfCapital: body.maxPositionPctOfCapital,
      });

      const rr = body.target1
        ? calculateRiskReward({
            entry: body.entry,
            stop: body.stop,
            target1: body.target1,
            target2: body.target2 ?? null,
          })
        : null;

      respond(res, {
        config,
        sizing,
        riskReward: rr,
        note:
          'Every figure here is arithmetic over the inputs you supplied; the calculation is shown step by step in `sizing.explain`. ' +
          'Break-even win rate describes the payoff structure only — it is not an estimate of how often this trade will work.',
      });
    } catch (err) {
      if (err instanceof InvalidRiskInput) throw badRequest(err.message);
      throw err;
    }
  }),
);

const atrStopSchema = z.object({
  entry: z.number().positive(),
  atr: z.number().positive(),
  direction: z.enum(['LONG', 'SHORT']),
  multiple: z.number().positive().max(10).default(1.5),
});

riskRouter.post(
  '/atr-stop',
  validate(atrStopSchema),
  asyncHandler(async (req, res) => {
    const { entry, atr, direction, multiple } = req.body as z.infer<typeof atrStopSchema>;
    respond(res, atrStop(entry, atr, direction, multiple));
  }),
);

riskRouter.get(
  '/daily-loss',
  validate(z.object({ realizedLossToday: z.coerce.number().min(0).default(0) }), 'query'),
  asyncHandler(async (req, res) => {
    const { realizedLossToday } = req.query as unknown as { realizedLossToday: number };
    const config = await riskConfigFor(req.user!.id);
    respond(res, checkDailyLoss(config, realizedLossToday));
  }),
);
