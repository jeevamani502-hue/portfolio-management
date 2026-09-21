import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, symbolParamSchema,
} from '../../middleware/index.js';
import { registryForUser } from '../../providers/registry.js';
import { badRequest } from '../../utils/errors.js';
import { isAvailable } from '../../utils/sourced.js';
import {
  getExpiries, getOptionChain, getOptionAnalytics, getFuturesAnalysis,
  underlyingInstrumentFor,
} from './options.service.js';
import { getCandles } from '../market/marketData.service.js';
import * as instrumentsRepo from '../../db/repositories/instruments.js';
import { buildSnapshot, InsufficientHistoryError } from '../../analysis/snapshot.js';
import { runSignalEngine } from '../../analysis/signals/engine.js';
import { buildOptionSetup } from '../../analysis/options/setupEngine.js';
import { sourced, unavailable } from '../../utils/sourced.js';

export const optionsRouter = Router();
optionsRouter.use(requireAuth);

const expirySchema = z.object({
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD').optional(),
});

optionsRouter.get(
  '/:symbol/expiries',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const registry = await registryForUser(req.user!.id);
    respond(res, await getExpiries(registry, symbol));
  }),
);

/** Resolve the requested expiry, defaulting to the nearest one. */
async function resolveExpiry(
  registry: Awaited<ReturnType<typeof registryForUser>>,
  symbol: string,
  requested: string | undefined,
): Promise<string> {
  if (requested) return requested;
  const expiries = await getExpiries(registry, symbol);
  if (!isAvailable(expiries) || expiries.value.length === 0) {
    throw badRequest(
      `No expiry supplied and none could be listed for ${symbol}. Pass ?expiry=YYYY-MM-DD.`,
    );
  }
  return expiries.value[0]!;
}

optionsRouter.get(
  '/:symbol/chain',
  validate(symbolParamSchema, 'params'),
  validate(expirySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const { expiry } = req.query as unknown as z.infer<typeof expirySchema>;
    const registry = await registryForUser(req.user!.id);
    const resolved = await resolveExpiry(registry, symbol, expiry);
    respond(res, await getOptionChain(registry, symbol, resolved), { expiry: resolved });
  }),
);

optionsRouter.get(
  '/:symbol/analytics',
  validate(symbolParamSchema, 'params'),
  validate(expirySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const { expiry } = req.query as unknown as z.infer<typeof expirySchema>;
    const registry = await registryForUser(req.user!.id);
    const resolved = await resolveExpiry(registry, symbol, expiry);
    respond(res, await getOptionAnalytics(registry, symbol, resolved), { expiry: resolved });
  }),
);

optionsRouter.get(
  '/:symbol/futures',
  validate(symbolParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const registry = await registryForUser(req.user!.id);
    respond(res, await getFuturesAnalysis(registry, symbol));
  }),
);

/**
 * Generate a concrete option trade from the live chain plus the underlying's
 * rule score.
 *
 * Capital and risk are required query parameters with no defaults. Guessing
 * how much money someone is prepared to lose would be the single worst
 * default in this codebase, so the engine refuses to run without them.
 */
const setupSchema = z.object({
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD').optional(),
  capital: z.coerce.number().positive('capital must be a positive rupee amount'),
  riskPercent: z.coerce.number().min(0.1).max(10).default(1),
  timeframe: z.enum(['15m', '1h', '1d']).default('1d'),
  atrStopMultiple: z.coerce.number().min(0.5).max(5).default(1.5),
  minRewardRisk: z.coerce.number().min(1).max(5).default(1.5),
});

optionsRouter.get(
  '/:symbol/setup',
  validate(symbolParamSchema, 'params'),
  validate(setupSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const q = req.query as unknown as z.infer<typeof setupSchema>;
    const registry = await registryForUser(req.user!.id);
    const resolved = await resolveExpiry(registry, symbol, q.expiry);

    const chain = await getOptionChain(registry, symbol, resolved);
    if (!isAvailable(chain)) {
      respond(res, chain, { expiry: resolved });
      return;
    }

    // The direction comes from the underlying, never from the chain alone:
    // OI and PCR describe positioning, not trend.
    const underlyingSymbol = underlyingInstrumentFor(symbol);
    const instrument = await instrumentsRepo.resolveSymbol(underlyingSymbol);
    if (!instrument) {
      throw badRequest(
        `Cannot score ${symbol}: its underlying "${underlyingSymbol}" is not in the instrument master.`,
      );
    }

    const candles = await getCandles(registry, instrument, q.timeframe, { bars: 300 });
    if (candles.candles.length === 0) {
      respond(
        res,
        unavailable(
          'no_underlying_history',
          `No price history for ${underlyingSymbol}, so no direction can be established for ${symbol}.`,
        ),
        { expiry: resolved },
      );
      return;
    }

    let snapshot;
    try {
      snapshot = buildSnapshot(instrument.tradingsymbol, q.timeframe, candles.candles);
    } catch (err) {
      if (err instanceof InsufficientHistoryError) {
        respond(
          res,
          unavailable('insufficient_history', err.message),
          { expiry: resolved },
        );
        return;
      }
      throw err;
    }

    const setup = buildOptionSetup({
      underlying: symbol.toUpperCase(),
      chain: chain.value,
      signal: runSignalEngine(snapshot),
      atr: snapshot.volatility.atr14,
      capital: q.capital,
      riskPercent: q.riskPercent,
      atrStopMultiple: q.atrStopMultiple,
      minRewardRisk: q.minRewardRisk,
    });

    // Inherit the chain's provenance: the setup is only as live as its prices.
    respond(
      res,
      sourced(setup, {
        source: chain.source,
        asOf: chain.asOf,
        freshness: 'optionChain',
        kind: 'rule_signal',
      }),
      { expiry: resolved, underlying: underlyingSymbol, timeframe: q.timeframe },
    );
  }),
);
