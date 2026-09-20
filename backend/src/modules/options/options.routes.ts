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
} from './options.service.js';

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
