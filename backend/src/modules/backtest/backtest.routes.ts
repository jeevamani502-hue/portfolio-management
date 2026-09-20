import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, rateLimit, timeframeSchema,
} from '../../middleware/index.js';
import { badRequest, notFound, dataUnavailable } from '../../utils/errors.js';
import { registryForUser } from '../../providers/registry.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { getCandles } from '../market/marketData.service.js';
import { runBacktest, type BacktestResult } from '../../analysis/backtest/engine.js';
import { buildStrategy, listStrategies } from '../../analysis/backtest/strategies.js';
import { DEFAULT_COSTS, type Segment } from '../../analysis/backtest/costs.js';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

export const backtestRouter = Router();
backtestRouter.use(requireAuth);

backtestRouter.get(
  '/strategies',
  asyncHandler(async (_req, res) => {
    respond(res, listStrategies(), {
      costModel: DEFAULT_COSTS,
      note:
        'Default cost rates reflect the published Indian fee structure at the time of writing and are configurable per run. Verify them against current SEBI/exchange circulars and your broker schedule before relying on backtest economics.',
    });
  }),
);

const runSchema = z.object({
  symbol: z.string().min(1).max(64),
  strategy: z.string().min(1).max(60),
  timeframe: timeframeSchema,
  params: z.record(z.number()).default({}),
  initialCapital: z.number().positive().max(1e10).default(500000),
  positionSizePct: z.number().min(0.01).max(1).default(0.95),
  segment: z.enum(['EQ_DELIVERY', 'EQ_INTRADAY', 'FUT', 'OPT']).default('EQ_DELIVERY'),
  allowShort: z.boolean().default(false),
  bars: z.coerce.number().int().min(100).max(2000).default(750),
  slippagePct: z.number().min(0).max(5).optional(),
  brokeragePerOrder: z.number().min(0).max(10000).optional(),
  name: z.string().max(120).optional(),
  persist: z.boolean().default(true),
});

backtestRouter.post(
  '/run',
  // Backtests are the heaviest synchronous work in the API.
  rateLimit({ bucket: 'backtest', limit: 10, windowSeconds: 300 }),
  validate(runSchema),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof runSchema>;

    const strategy = buildStrategy(b.strategy, b.params);
    if (!strategy) {
      throw badRequest(
        `Unknown strategy "${b.strategy}". Available: ${listStrategies().map((s) => s.key).join(', ')}`,
      );
    }

    const instrument = await instrumentsRepo.resolveSymbol(b.symbol);
    if (!instrument) throw badRequest(`No instrument matches "${b.symbol}"`);

    const registry = await registryForUser(req.user!.id);

    let candles;
    try {
      const result = await getCandles(registry, instrument, b.timeframe, { bars: b.bars });
      candles = result.candles;
    } catch (err) {
      throw dataUnavailable(
        `${instrument.tradingsymbol} history`,
        err instanceof Error ? err.message : 'unknown error',
      );
    }

    if (candles.length < 60) {
      throw badRequest(
        `A backtest needs at least 60 bars; only ${candles.length} ${b.timeframe} bars are available for ${instrument.tradingsymbol}.`,
      );
    }

    const segment = b.segment as Segment;
    const costConfig = { ...DEFAULT_COSTS[segment] };
    if (b.slippagePct !== undefined) costConfig.slippagePct = b.slippagePct;
    if (b.brokeragePerOrder !== undefined) costConfig.brokeragePerOrder = b.brokeragePerOrder;

    const barsPerYear =
      b.timeframe === '1d' ? 252
      : b.timeframe === '1w' ? 52
      : b.timeframe === '1M' ? 12
      : b.timeframe === '1h' ? 252 * 6
      : b.timeframe === '4h' ? 252 * 2
      : b.timeframe === '30m' ? 252 * 12
      : b.timeframe === '15m' ? 252 * 25
      : b.timeframe === '5m' ? 252 * 75
      : 252 * 375;

    const result = runBacktest(candles, strategy, {
      initialCapital: b.initialCapital,
      positionSizePct: b.positionSizePct,
      segment,
      costConfig,
      allowShort: b.allowShort,
      barsPerYear,
    });

    let id: string | null = null;
    if (b.persist) id = await persistBacktest(req.user!.id, b, instrument.id, result);

    respond(res, {
      id,
      symbol: `${instrument.exchange}:${instrument.tradingsymbol}`,
      strategy: b.strategy,
      timeframe: b.timeframe,
      period: {
        from: candles[0]?.ts ?? null,
        to: candles.at(-1)?.ts ?? null,
        bars: candles.length,
      },
      result,
      disclaimer:
        'HISTORICAL SIMULATION on past data — not live trading performance and not a forecast. ' +
        'Live results differ through execution quality, liquidity, gaps and the fact that a strategy chosen because it scored well on this sample will typically do worse on data it has not seen.',
    });
  }),
);

async function persistBacktest(
  userId: string,
  input: z.infer<typeof runSchema>,
  instrumentId: number,
  result: BacktestResult,
): Promise<string | null> {
  try {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO backtests
         (user_id, name, strategy, universe, timeframe, from_date, to_date, params, costs,
          status, initial_capital, final_capital, total_return_pct, cagr, max_drawdown_pct,
          win_rate, avg_win, avg_loss, profit_factor, sharpe, trade_count, equity_curve,
          completed_at)
       VALUES ($1,$2,$3,$4,$5,
               COALESCE(($6)::date, CURRENT_DATE), COALESCE(($7)::date, CURRENT_DATE),
               $8::jsonb,$9::jsonb,'DONE',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb, now())
       RETURNING id`,
      [
        userId,
        input.name ?? `${input.strategy} on ${input.symbol}`,
        input.strategy,
        [input.symbol],
        input.timeframe,
        result.equityCurve[0]?.ts?.slice(0, 10) ?? null,
        result.equityCurve.at(-1)?.ts?.slice(0, 10) ?? null,
        JSON.stringify(input.params),
        JSON.stringify({ segment: input.segment, slippagePct: input.slippagePct }),
        result.initialCapital, result.finalCapital, result.totalReturnPct, result.cagr,
        result.maxDrawdownPct, result.winRate, result.avgWin, result.avgLoss,
        result.profitFactor, result.sharpe, result.tradeCount,
        // Downsample the curve so a long run does not bloat the row.
        JSON.stringify(downsample(result.equityCurve, 500)),
      ],
    );

    const id = row?.id;
    if (!id) return null;

    for (const t of result.trades.slice(0, 2000)) {
      await query(
        `INSERT INTO backtest_trades
           (backtest_id, instrument_id, symbol, direction, entry_at, entry_price,
            exit_at, exit_price, quantity, gross_pnl, charges, net_pnl, exit_reason, mae, mfe)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id, instrumentId, input.symbol, t.direction, t.entryTs, t.entryPrice,
          t.exitTs, t.exitPrice, t.quantity, t.grossPnl, t.charges, t.netPnl,
          t.exitReason, t.mae, t.mfe,
        ],
      );
    }
    return id;
  } catch (err) {
    logger.warn({ err }, 'Backtest result not persisted');
    return null;
  }
}

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr;
  const step = Math.ceil(arr.length / maxPoints);
  const out = arr.filter((_, i) => i % step === 0);
  const lastItem = arr.at(-1);
  if (lastItem !== undefined && out.at(-1) !== lastItem) out.push(lastItem);
  return out;
}

backtestRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const rows = await queryRows(
      `SELECT id, name, strategy, universe, timeframe, from_date, to_date, status,
              initial_capital, final_capital, total_return_pct, cagr, max_drawdown_pct,
              win_rate, profit_factor, sharpe, trade_count, created_at
         FROM backtests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user!.id],
    );
    respond(res, rows);
  }),
);

backtestRouter.get(
  '/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const row = await queryOne(
      `SELECT * FROM backtests WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    if (!row) throw notFound('Backtest not found');
    respond(res, row, {
      disclaimer:
        'Historical simulation on past data. Not live trading performance and not a forecast.',
    });
  }),
);

backtestRouter.get(
  '/:id/trades',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  asyncHandler(async (req, res) => {
    const { id } = req.params as unknown as { id: string };
    const owned = await queryOne<{ id: string }>(
      `SELECT id FROM backtests WHERE id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    if (!owned) throw notFound('Backtest not found');

    respond(res, await queryRows(
      `SELECT symbol, direction, entry_at, entry_price, exit_at, exit_price, quantity,
              gross_pnl, charges, net_pnl, exit_reason, mae, mfe
         FROM backtest_trades WHERE backtest_id = $1 ORDER BY entry_at`,
      [id],
    ));
  }),
);
