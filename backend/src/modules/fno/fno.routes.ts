/**
 * F&O decision routes: the graded checklist for an underlying, the signal
 * journal, and the track record computed from it.
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, symbolParamSchema,
} from '../../middleware/index.js';
import { registryForUser } from '../../providers/registry.js';
import { evaluateUnderlying, listSignals, signalPerformance } from './fno.service.js';

export const fnoRouter = Router();
fnoRouter.use(requireAuth);

/**
 * Capital and risk are required with no defaults, for the same reason the
 * setup endpoint refuses them: how much of someone's money is at stake is
 * not a number this code should invent.
 */
const decisionSchema = z.object({
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expiry must be YYYY-MM-DD').optional(),
  capital: z.coerce.number().positive('capital must be a positive rupee amount'),
  riskPercent: z.coerce.number().min(0.1).max(10).default(1),
  biasTimeframe: z.enum(['1h', '1d']).default('1d'),
  entryTimeframe: z.enum(['5m', '15m', '1h']).default('15m'),
  atrStopMultiple: z.coerce.number().min(0.5).max(5).default(1.5),
  minRewardRisk: z.coerce.number().min(1).max(5).default(1.5),
  /** Journal an ENTER-grade decision. On by default: looking is how the record builds. */
  record: z.coerce.boolean().default(true),
});

fnoRouter.get(
  '/:symbol/decision',
  validate(symbolParamSchema, 'params'),
  validate(decisionSchema, 'query'),
  asyncHandler(async (req, res) => {
    const { symbol } = req.params as unknown as { symbol: string };
    const q = req.query as unknown as z.infer<typeof decisionSchema>;
    const registry = await registryForUser(req.user!.id);

    const evaluation = await evaluateUnderlying(registry, symbol, {
      capital: q.capital,
      riskPercent: q.riskPercent,
      ...(q.expiry ? { expiry: q.expiry } : {}),
      biasTimeframe: q.biasTimeframe,
      entryTimeframe: q.entryTimeframe,
      atrStopMultiple: q.atrStopMultiple,
      minRewardRisk: q.minRewardRisk,
      record: q.record ? { userId: req.user!.id, origin: 'manual' } : null,
    });

    respond(res, evaluation.result, {
      expiry: evaluation.expiry,
      underlying: evaluation.underlyingSymbol,
      biasTimeframe: q.biasTimeframe,
      entryTimeframe: q.entryTimeframe,
      signalId: evaluation.signalId,
    });
  }),
);

const listSchema = z.object({
  status: z.enum(['ACTIVE', 'RESOLVED']).optional(),
  underlying: z.string().max(20).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

fnoRouter.get(
  '/signals',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    respond(res, await listSignals(req.user!.id, {
      ...(q.status ? { status: q.status } : {}),
      ...(q.underlying ? { underlying: q.underlying } : {}),
      limit: q.limit,
    }), {
      note: 'Every graded signal the engine issued for you, with the plan it carried at issue and how it resolved.',
    });
  }),
);

const perfSchema = z.object({
  sinceDays: z.coerce.number().int().min(7).max(365).default(90),
});

fnoRouter.get(
  '/signals/performance',
  validate(perfSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof perfSchema>;
    respond(res, await signalPerformance(req.user!.id, q.sinceDays));
  }),
);
