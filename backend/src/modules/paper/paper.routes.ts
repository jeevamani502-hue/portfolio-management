import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, respond, requireAuth, validate } from '../../middleware/index.js';
import { badRequest } from '../../utils/errors.js';
import * as paper from './paper.service.js';
import { adviseOnOpenPositions } from './advisor.js';
import { getPaperStatus } from './status.service.js';

export const paperRouter = Router();
paperRouter.use(requireAuth);

/**
 * Capital has no default anywhere in this module.
 *
 * A simulation run against an arbitrary account size produces position sizes
 * and a return percentage that mean nothing to the person reading them, so
 * the number must come from the user even though no real money is involved.
 */
const configSchema = z.object({
  isEnabled: z.boolean().optional(),
  capital: z.number().positive().optional(),
  riskPerTradePct: z.number().min(0.1).max(10).optional(),
  maxOpenPositions: z.number().int().min(1).max(20).optional(),
  maxTradesPerDay: z.number().int().min(1).max(50).optional(),
  maxDailyLossPct: z.number().min(0.1).max(25).optional(),
  minConfirmation: z.number().int().min(0).max(100).optional(),
  underlyings: z.array(z.string().min(1).max(20)).min(1).max(10).optional(),
  tradeOptions: z.boolean().optional(),
  tradeEquity: z.boolean().optional(),
});

paperRouter.get(
  '/config',
  asyncHandler(async (req, res) => {
    respond(res, await paper.getConfig(req.user!.id));
  }),
);

paperRouter.put(
  '/config',
  validate(configSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof configSchema>;
    try {
      respond(res, await paper.upsertConfig(req.user!.id, body));
    } catch (err) {
      throw badRequest(err instanceof Error ? err.message : 'could not save the configuration');
    }
  }),
);

paperRouter.get(
  '/performance',
  asyncHandler(async (req, res) => {
    respond(res, await paper.getPerformance(req.user!.id));
  }),
);

const listSchema = z.object({
  status: z.enum(['OPEN', 'CLOSED']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

paperRouter.get(
  '/trades',
  validate(listSchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof listSchema>;
    respond(res, await paper.listTrades(req.user!.id, {
      ...(q.status ? { status: q.status } : {}),
      limit: q.limit,
    }));
  }),
);

/**
 * Run a sweep now rather than waiting for the worker.
 *
 * Useful for seeing what the engine would do without leaving it enabled for
 * a day, and it respects every limit exactly as the scheduled run does.
 */
paperRouter.post(
  '/sweep',
  asyncHandler(async (req, res) => {
    const entries = await paper.runEntrySweep(req.user!.id);
    const exits = await paper.runExitSweep(req.user!.id);
    respond(res, { entries, exits });
  }),
);

paperRouter.post(
  '/trades/:id/close',
  asyncHandler(async (req, res) => {
    const { id } = req.params as { id: string };
    const closed = await paper.closeManually(req.user!.id, id);
    if (!closed) {
      throw badRequest(
        'That trade could not be closed — it may already be closed, or there is no current price to close it at.',
      );
    }
    respond(res, { closed: true });
  }),
);

/**
 * What the advisor would do about each open position, most urgent first.
 */
paperRouter.get(
  '/advice',
  asyncHandler(async (req, res) => {
    respond(res, await adviseOnOpenPositions(req.user!.id));
  }),
);

/**
 * Take the setup the user is looking at, in one click.
 *
 * Every risk limit still applies: the button expresses intent, it does not
 * override the caps the user set for themselves.
 */
const takeSchema = z.object({
  underlying: z.string().min(1).max(20),
});

paperRouter.post(
  '/take',
  validate(takeSchema),
  asyncHandler(async (req, res) => {
    const { underlying } = req.body as z.infer<typeof takeSchema>;
    const result = await paper.openFromSetup(req.user!.id, underlying);
    if (!result.opened) throw badRequest(result.reason);
    respond(res, { opened: true, underlying: underlying.toUpperCase() });
  }),
);

/**
 * What the engine is doing and why nothing has traded.
 *
 * Deliberately a separate endpoint from the config: "is it on" and "can it
 * actually trade right now" are different questions, and only the second
 * one explains an empty ledger.
 */
paperRouter.get(
  '/status',
  asyncHandler(async (req, res) => {
    respond(res, await getPaperStatus(req.user!.id));
  }),
);
